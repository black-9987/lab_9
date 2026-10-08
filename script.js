const SAMPLE_COUNT = 256;
const ORTHOGONALITY_SAMPLES = 4096;
const TAU = 2 * Math.PI;

const app = {
  mode: 'ask',
  detector: 'coherent',
  stage: 'message',
  result: null,
  runCount: 0,
};

const byId = (id) => document.getElementById(id);
const canvas = byId('signal-canvas');
const context = canvas.getContext('2d');

function readSettings() {
  const bitsText = byId('bits-input').value.trim();
  const bits = [...bitsText].map(Number);
  const tb = Number(byId('tb-input').value) / 1000;
  return {
    bits,
    tb,
    askCarrier: Number(byId('ask-carrier-input').value),
    f0: Number(byId('f0-input').value),
    f1: Number(byId('f1-input').value),
    a0: Number(byId('a0-input').value),
    a1: Number(byId('a1-input').value),
    snrDb: Number(byId('snr-input').value),
  };
}

function makeReference(frequency, tb, count, phase = 0, sine = false) {
  return Array.from({ length: count }, (_, index) => {
    const time = (index * tb) / count;
    const angle = TAU * frequency * time + phase;
    return sine ? Math.sin(angle) : Math.cos(angle);
  });
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function askTransmitter(bits, settings) {
  const carrier = makeReference(settings.askCarrier, settings.tb, SAMPLE_COUNT);
  const samples = [];
  for (const bit of bits) {
    const amplitude = bit ? settings.a1 : settings.a0;
    for (const value of carrier) samples.push(amplitude * value);
  }
  return samples;
}

function bfskTransmitter(bits, settings) {
  const tone0 = makeReference(settings.f0, settings.tb, SAMPLE_COUNT);
  const tone1 = makeReference(settings.f1, settings.tb, SAMPLE_COUNT);
  const samples = [];
  for (const bit of bits) samples.push(...(bit ? tone1 : tone0));
  return samples;
}

function createGaussian(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  return () => {
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    return radius * Math.cos(TAU * uniform());
  };
}

function channel(transmitted, snrDb, seed) {
  const power = transmitted.reduce((sum, value) => sum + value * value, 0) / transmitted.length;
  const noisePower = power / (10 ** (snrDb / 10));
  const gaussian = createGaussian(seed);
  const scale = Math.sqrt(noisePower);
  return transmitted.map((value) => value + scale * gaussian());
}

function askCoherentReceiver(received, bits, settings) {
  const reference = makeReference(settings.askCarrier, settings.tb, SAMPLE_COUNT);
  const referenceEnergy = dot(reference, reference);
  const threshold = (settings.a0 + settings.a1) / 2;
  const metrics = [];
  const decisions = [];
  for (let bitIndex = 0; bitIndex < bits.length; bitIndex += 1) {
    const segment = received.slice(bitIndex * SAMPLE_COUNT, (bitIndex + 1) * SAMPLE_COUNT);
    const amplitudeEstimate = dot(segment, reference) / referenceEnergy;
    metrics.push(amplitudeEstimate);
    decisions.push(amplitudeEstimate >= threshold ? 1 : 0);
  }
  return { decisions, metrics, threshold };
}

function bfskReceiver(received, bits, settings, detector) {
  const references = [
    makeReference(settings.f0, settings.tb, SAMPLE_COUNT),
    makeReference(settings.f1, settings.tb, SAMPLE_COUNT),
  ];
  const quadrature = detector === 'noncoherent'
    ? references.map((reference, index) => makeReference(index === 0 ? settings.f0 : settings.f1, settings.tb, SAMPLE_COUNT, 0, true))
    : null;
  const metrics = [];
  const decisions = [];
  for (let bitIndex = 0; bitIndex < bits.length; bitIndex += 1) {
    const segment = received.slice(bitIndex * SAMPLE_COUNT, (bitIndex + 1) * SAMPLE_COUNT);
    const scores = references.map((reference, toneIndex) => {
      const inPhase = dot(segment, reference);
      if (quadrature) {
        const inQuadrature = dot(segment, quadrature[toneIndex]);
        return inPhase * inPhase + inQuadrature * inQuadrature;
      }
      return inPhase / Math.sqrt(dot(reference, reference));
    });
    metrics.push(scores);
    decisions.push(scores[1] > scores[0] ? 1 : 0);
  }
  return { decisions, metrics };
}

function calculateBfskInnerProducts(f0, f1, tb) {
  const frequencies = [f0, f0, f1, f1];
  const isSine = [false, true, false, true];
  const bases = frequencies.map((frequency, basisIndex) => {
    const tone = makeReference(frequency, tb, ORTHOGONALITY_SAMPLES, 0, isSine[basisIndex]);
    const energy = dot(tone, tone) / ORTHOGONALITY_SAMPLES;
    return tone.map((value) => value / Math.sqrt(energy * ORTHOGONALITY_SAMPLES));
  });
  const matrix = bases.map((basis) => bases.map((other) => dot(basis, other)));
  const maxCrossProduct = Math.max(...matrix.flatMap((row, rowIndex) => row.map((value, colIndex) => rowIndex === colIndex ? 0 : Math.abs(value))));
  const normalizedSpacing = (f1 - f0) * tb;
  const cycles0 = f0 * tb;
  const cycles1 = f1 * tb;
  const onIntegerToneGrid = Math.abs(cycles0 - Math.round(cycles0)) < 0.002 && Math.abs(cycles1 - Math.round(cycles1)) < 0.002;
  return { matrix, maxCrossProduct, normalizedSpacing, cycles0, cycles1, orthogonal: onIntegerToneGrid && maxCrossProduct < 0.025 };
}

function simulate() {
  const settings = readSettings();
  if (!settings.bits.length || [...byId('bits-input').value.trim()].some((character) => character !== '0' && character !== '1')) {
    byId('bits-error').textContent = 'Enter a sequence containing only 0 and 1.';
    return;
  }
  byId('bits-error').textContent = '';
  app.runCount += 1;
  const transmitted = app.mode === 'ask' ? askTransmitter(settings.bits, settings) : bfskTransmitter(settings.bits, settings);
  const received = channel(transmitted, settings.snrDb, 907 + app.runCount * 7919);
  const detected = app.mode === 'ask'
    ? askCoherentReceiver(received, settings.bits, settings)
    : bfskReceiver(received, settings.bits, settings, app.detector);
  const reconstructed = app.mode === 'ask'
    ? askTransmitter(detected.decisions, settings)
    : bfskTransmitter(detected.decisions, settings);
  app.result = { settings, transmitted, received, detected, reconstructed };
  render();
}

function drawGrid(width, height, bits) {
  const left = 42;
  const right = width - 12;
  const top = 13;
  const bottom = height - 24;
  context.lineWidth = 1;
  context.strokeStyle = '#e3e2d8';
  context.fillStyle = '#888d82';
  context.font = '9px "DM Mono", monospace';
  for (let index = 0; index <= 4; index += 1) {
    const y = top + ((bottom - top) * index) / 4;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.fillText((1 - index / 2).toFixed(1), 4, y + 3);
  }
  for (let index = 0; index <= bits; index += 1) {
    const x = left + ((right - left) * index) / bits;
    context.beginPath();
    context.strokeStyle = index === 0 || index === bits ? '#d4d4c9' : '#d8d8ce';
    context.setLineDash(index === 0 || index === bits ? [] : [2, 4]);
    context.moveTo(x, top);
    context.lineTo(x, bottom);
    context.stroke();
    context.setLineDash([]);
    if (index < bits && width > 490) context.fillText(String(index + 1), x + 4, top + 10);
  }
  return { left, right, top, bottom };
}

function drawSignal() {
  if (!app.result) return;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  context.clearRect(0, 0, width, height);
  const { settings, transmitted, received, reconstructed, detected } = app.result;
  const plot = drawGrid(width, height, settings.bits.length);
  const samples = app.stage === 'message'
    ? settings.bits.flatMap((bit) => Array(SAMPLE_COUNT).fill(bit ? 0.82 : 0.18))
    : app.stage === 'transmit' ? transmitted
      : app.stage === 'channel' ? received
        : settings.bits.flatMap((_, index) => Array(SAMPLE_COUNT).fill(detected.decisions[index] ? 0.82 : 0.18));
  const maxAmplitude = app.stage === 'message' || app.stage === 'receive' ? 1 : Math.max(1.15, ...samples.map(Math.abs));
  const mid = (plot.top + plot.bottom) / 2;
  const amplitude = (plot.bottom - plot.top) * 0.44;
  const xFor = (index) => plot.left + ((plot.right - plot.left) * index) / (samples.length - 1);
  const yFor = (value) => mid - (value / maxAmplitude) * amplitude;

  if (app.stage === 'message' || app.stage === 'receive') {
    context.beginPath();
    samples.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      if (index === 0) context.moveTo(x, y);
      else if (index % SAMPLE_COUNT === 0) {
        context.lineTo(x, yFor(samples[index - 1]));
        context.lineTo(x, y);
      } else context.lineTo(x, y);
    });
    context.strokeStyle = app.stage === 'receive' ? '#c24f3d' : '#416e5e';
    context.lineWidth = 2;
    context.stroke();
  } else {
    context.beginPath();
    samples.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = app.stage === 'channel' ? '#c24f3d' : '#416e5e';
    context.lineWidth = 1.5;
    context.stroke();
  }

  if (app.stage === 'receive') {
    context.fillStyle = '#c24f3d';
    context.font = '9px "DM Mono", monospace';
    settings.bits.forEach((_, index) => {
      const x = plot.left + ((plot.right - plot.left) * (index + 0.5)) / settings.bits.length;
      context.fillText(String(detected.decisions[index]), x - 2, plot.top + 12);
    });
  }
  byId('axis-right').textContent = `${(settings.bits.length * settings.tb * 1000).toFixed(0)} ms`;
}

function renderMatrix() {
  const settings = readSettings();
  const result = calculateBfskInnerProducts(settings.f0, settings.f1, settings.tb);
  const labels = ['cos f₀', 'sin f₀', 'cos f₁', 'sin f₁'];
  const table = byId('matrix-table');
  table.innerHTML = `<thead><tr><th>⟨i,j⟩</th>${labels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${result.matrix.map((row, rowIndex) => `<tr><th>${labels[rowIndex]}</th>${row.map((value, colIndex) => {
    const rounded = Math.abs(value) < 0.0005 ? 0 : value;
    const cellClass = rowIndex === colIndex ? 'diagonal' : Math.abs(value) < 0.025 ? 'zero' : 'nonzero';
    return `<td class="${cellClass}">${rounded.toFixed(3)}</td>`;
  }).join('')}</tr>`).join('')}</tbody>`;
  byId('matrix-meta').innerHTML = `<span>f₀T<sub>b</sub> = <strong>${result.cycles0.toFixed(2)}</strong> · f₁T<sub>b</sub> = <strong>${result.cycles1.toFixed(2)}</strong></span><span>Δf · T<sub>b</sub> = <strong>${result.normalizedSpacing.toFixed(2)}</strong></span>`;
  const status = byId('orth-status');
  status.classList.toggle('not-orthogonal', !result.orthogonal);
  status.querySelector('b').textContent = result.orthogonal ? 'ORTHOGONAL BASIS' : 'NOT ORTHOGONAL';
  byId('orth-copy').classList.toggle('is-invalid', !result.orthogonal);
  return result;
}

function render() {
  if (!app.result) return;
  const { settings, detected } = app.result;
  const errors = settings.bits.reduce((count, bit, index) => count + (bit !== detected.decisions[index] ? 1 : 0), 0);
  byId('accuracy').innerHTML = `${settings.bits.length - errors} / ${settings.bits.length} <span>correct</span>`;
  byId('decision-row').innerHTML = detected.decisions.map((bit, index) => {
    const wrong = bit !== settings.bits[index];
    return `<span class="decision-cell ${bit ? '' : 'zero'} ${wrong ? 'error' : ''}" title="Bit ${index + 1}: sent ${settings.bits[index]}, received ${bit}">${bit}</span>`;
  }).join('');
  if (app.mode === 'ask') {
    const threshold = detected.threshold;
    byId('detector-metric-label').textContent = 'COHERENT CORRELATOR';
    byId('detector-metric').textContent = `Amplitude threshold: ${threshold.toFixed(2)}`;
  } else {
    byId('detector-metric-label').textContent = app.detector === 'coherent' ? 'COHERENT CORRELATORS' : 'I² + Q² ENERGY';
    byId('detector-metric').textContent = app.detector === 'coherent' ? 'Choose the larger tone correlation' : 'Choose the larger quadrature energy';
  }
  renderMatrix();
  drawSignal();
}

function syncMode() {
  const isAsk = app.mode === 'ask';
  document.querySelectorAll('.mode-tab').forEach((button) => {
    const active = button.dataset.mode === app.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  byId('tone-fields').hidden = isAsk;
  byId('amplitude-fields').hidden = !isAsk;
  byId('ask-carrier-field').hidden = !isAsk;
  byId('detector-control').hidden = isAsk;
  byId('orthogonality').classList.toggle('is-current', !isAsk);
  byId('mode-caption').textContent = isAsk
    ? 'Two amplitudes, one carrier. The receiver measures a single coherent correlation.'
    : 'Two tones, one amplitude. Compare coherent correlators or use phase-independent I/Q energy.';
  byId('scope-title').textContent = isAsk ? 'Amplitude-shift keyed signal' : 'Binary frequency-shift keyed signal';
  byId('scope-readout-label').textContent = isAsk ? 'CARRIER' : 'TONE PAIR';
  byId('scope-readout-value').textContent = isAsk ? `${byId('ask-carrier-input').value} Hz` : `${byId('f0-input').value} / ${byId('f1-input').value}`;
  syncDetector();
}

function syncDetector() {
  document.querySelectorAll('.detector-tab').forEach((button) => {
    const active = button.dataset.detector === app.detector;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  byId('detector-description').textContent = app.detector === 'coherent'
    ? 'Correlate against both known-phase tones; select the larger output.'
    : 'Use I² + Q² energy at each tone; phase reference is not required.';
}

function updateBitPreview() {
  const input = byId('bits-input');
  const text = input.value.replace(/[^01]/g, '').slice(0, 16);
  if (text !== input.value) input.value = text;
  byId('bits-preview').innerHTML = [...text].map((bit) => `<span class="bit-preview-cell ${bit === '1' ? 'one' : ''}">${bit}</span>`).join('');
  byId('bits-error').textContent = text.length ? '' : 'Enter at least one bit.';
}

function updateControls() {
  byId('a0-output').value = Number(byId('a0-input').value).toFixed(2);
  byId('a1-output').value = Number(byId('a1-input').value).toFixed(2);
  byId('snr-output').value = `${byId('snr-input').value} dB`;
  byId('scope-readout-value').textContent = app.mode === 'ask'
    ? `${byId('ask-carrier-input').value} Hz`
    : `${byId('f0-input').value} / ${byId('f1-input').value}`;
  updateSpacingNote();
  renderMatrix();
}

function updateSpacingNote() {
  const settings = readSettings();
  const ratio = (settings.f1 - settings.f0) * settings.tb;
  const nearest = Math.round(ratio);
  const aligned = Math.abs(ratio - nearest) < 0.002;
  byId('spacing-note').innerHTML = `Δf · T<sub>b</sub> = <strong>${ratio.toFixed(2)}</strong> ${aligned ? '· integer spacing' : '· not on integer grid'}`;
}

function setStage(stage) {
  app.stage = stage;
  document.querySelectorAll('.trace-tab').forEach((button) => {
    const active = button.dataset.stage === stage;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const labels = {
    message: ['Input bits', 'SOURCE MESSAGE'],
    transmit: ['Modulated carrier', 'TRANSMITTER OUTPUT'],
    channel: ['Received waveform + noise', 'NOISY CHANNEL OUTPUT'],
    receive: ['Detected bit stream', 'RECEIVER DECISIONS'],
  };
  byId('legend-label').textContent = labels[stage][0];
  byId('trace-stage-label').textContent = labels[stage][1];
  drawSignal();
}

document.querySelectorAll('.mode-tab').forEach((button) => button.addEventListener('click', () => {
  app.mode = button.dataset.mode;
  syncMode();
  simulate();
}));
document.querySelectorAll('.detector-tab').forEach((button) => button.addEventListener('click', () => {
  app.detector = button.dataset.detector;
  syncDetector();
  simulate();
}));
document.querySelectorAll('.trace-tab').forEach((button) => button.addEventListener('click', () => setStage(button.dataset.stage)));
byId('run-button').addEventListener('click', simulate);
byId('bits-input').addEventListener('input', () => { updateBitPreview(); simulate(); });
['tb-input', 'ask-carrier-input', 'f0-input', 'f1-input', 'a0-input', 'a1-input', 'snr-input'].forEach((id) => {
  byId(id).addEventListener('input', () => { updateControls(); simulate(); });
});
window.addEventListener('resize', drawSignal);

updateBitPreview();
syncMode();
updateControls();
simulate();