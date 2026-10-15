/**
 * audioChime.js - Web Audio API Synthesizer for Quiet Digital Geofence Notifications
 * Replaces harsh loudspeaker noise with gentle, melodic electronic chimes.
 */

class AudioChimeService {
  constructor() {
    this.audioCtx = null;
    this.isMuted = false;
  }

  init() {
    if (!this.audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
  }

  playChime(type = 'geofence') {
    if (this.isMuted) return;

    try {
      this.init();
      if (!this.audioCtx) return;

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;

      if (type === 'geofence') {
        // Melodic 3-tone pleasant arrival chime: C5 -> E5 -> G5
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, i) => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.12);

          // Soft attack and smooth decay
          gain.gain.setValueAtTime(0.001, now + i * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.12 + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.45);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc.start(now + i * 0.12);
          osc.stop(now + i * 0.12 + 0.5);
        });
      } else if (type === 'pickup_collected') {
        // Success ding: E5 -> B5
        const notes = [659.25, 987.77];
        notes.forEach((freq, i) => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + i * 0.1);

          gain.gain.setValueAtTime(0.001, now + i * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.1 + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.1 + 0.35);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc.start(now + i * 0.1);
          osc.stop(now + i * 0.1 + 0.4);
        });
      }
    } catch (e) {
      console.warn('Audio chime playback note:', e);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }
}

window.audioChime = new AudioChimeService();
