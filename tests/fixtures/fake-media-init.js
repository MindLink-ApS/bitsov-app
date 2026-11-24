// A fake microphone (and camera) for browser tests that place a call.
// Loaded with page.addInitScript before the app starts, in every engine:
// headless Chrome and Linux WebKit have no capture device and refuse
// getUserMedia, which ends the call before its card appears. This answers
// with a quiet tone and a plain picture made in the page, so no device,
// permission prompt or browser flag is needed.
(() => {
  // On the prototype: WebKit may hand the page a fresh mediaDevices object after
  // this script ran, which drops anything set on the first one.
  const media = window.MediaDevices ? window.MediaDevices.prototype : (navigator.mediaDevices || {});
  const silentAudio = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    level.gain.value = 0.01;
    const out = ctx.createMediaStreamDestination();
    tone.connect(level).connect(out);
    tone.start();
    return out.stream.getAudioTracks();
  };
  const plainVideo = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const g = canvas.getContext('2d');
    if (g) { g.fillStyle = '#446'; g.fillRect(0, 0, canvas.width, canvas.height); }
    return canvas.captureStream(15).getVideoTracks();
  };
  const define = (name, value) => Object.defineProperty(media, name, { value, configurable: true, writable: true });
  define('getUserMedia', async (constraints = {}) => {
    // A browser build without Web Audio or canvas capture still gets a stream, just without that track.
    const tracks = (make) => { try { return make(); } catch { return []; } };
    return new MediaStream([
      ...(constraints.audio ? tracks(silentAudio) : []),
      ...(constraints.video ? tracks(plainVideo) : []),
    ]);
  });
  define('enumerateDevices', async () => [
    { deviceId: 'fake-mic', groupId: 'fake', kind: 'audioinput', label: 'Test microphone', toJSON() { return this; } },
    { deviceId: 'fake-cam', groupId: 'fake', kind: 'videoinput', label: 'Test camera', toJSON() { return this; } },
  ]);
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: Object.create(media), configurable: true });
})();
