/* A visual-only audio tap. The destination stays connected when the effect is off. */
class LyraInkBackground {
  constructor(audio, canvas, onError) {
    this.audio = audio;
    this.canvas = canvas;
    this.onError = onError;
    this.enabled = false;
    this.frame = 0;
    this.time = 0;
    this.lastTime = 0;
    this.energy = [0, 0, 0];
    this.bandPeaks = [0.01, 0.004, 0.001];
    this.level = 0;
    this.flowAngle = 0;
    this.flowTurn = 0;
    this.flowSpeed = 0.05;
    this.directionTime = 0;
    this.flow = new Float32Array(2);
    this.color = [0.79, 0.66, 0.29];
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    audio.addEventListener('play', () => {
      if (this.source && this.context && this.context.state !== 'running') {
        this.context.resume().catch(() => {});
      }
      this.start();
    });
    audio.addEventListener('pause', () => this.stop());
    audio.addEventListener('ended', () => this.stop());
    audio.addEventListener('emptied', () => { this.stop(); this.resetSignal(); });
    audio.addEventListener('seeking', () => this.resetSignal());
    document.addEventListener('visibilitychange', () => document.hidden ? this.stop() : this.start());
    // Resume an existing audio route even if the visual has since been switched off.
    document.addEventListener('pointerdown', () => {
      if ((!this.enabled && !this.source) || document.hidden) return;
      if (!this.enabled && this.source) {
        if (this.context && this.context.state !== 'running') {
          this.context.resume().catch(() => {});
        }
        return;
      }
      // AudioContext creation/resume must happen in the trusted gesture itself. Waiting
      // for the media element's asynchronous `play` event is too late on WebView2 after
      // a launch, resume from sleep, or output-device change and used to leave the ink
      // permanently animating at its idle values.
      this.prepareAudio().then((ready) => {
        if (ready) this.start(true);
      }).catch((error) => this.handleAudioError(error));
    }, { passive: true });
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.stop();
      this.gl = null;
    });
    canvas.addEventListener('webglcontextrestored', () => { this.failed = false; this.start(); });
  }

  setEnabled(enabled, color) {
    this.enabled = enabled;
    const target = document.body.classList.contains('fullscreen-player-open')
      ? document.querySelector('.fullscreen-backdrop') : document.getElementById('appShell');
    if (target && this.canvas.parentElement !== target) target.appendChild(this.canvas);
    if (/^#[0-9a-f]{6}$/i.test(color || '')) {
      this.color = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
    }
    if (enabled) this.start();
    else this.stop();
  }

  async prepareAudio() {
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio analysis is unavailable');
      this.context ||= new AudioContextClass();
      await this.context.resume();
      // Do not reroute playback into a suspended context.
      if (this.context.state !== 'running') return false;
      if (!this.source) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        // Smooth the visual envelopes ourselves; FFT smoothing hides drum attacks.
        analyser.smoothingTimeConstant = 0;
        this.source = this.context.createMediaElementSource(this.audio);
        this.source.connect(this.context.destination);
        this.source.connect(analyser);
        this.analyser = analyser;
        this.bins = new Float32Array(analyser.frequencyBinCount);
        this.waveform = new Float32Array(analyser.fftSize);
      }
      return true;
    })();
    try { return await this.preparing; } finally { this.preparing = null; }
  }

  isRetryableAudioError(error) {
    return ['NotAllowedError', 'InvalidStateError', 'AbortError'].includes(error?.name);
  }

  handleAudioError(error) {
    // Gesture/autoplay policy failures are temporary. Keep the effect eligible for the
    // next pointer gesture instead of poisoning it until Lyra is restarted.
    if (this.isRetryableAudioError(error)) return;
    this.failed = true;
    this.stop();
    this.onError?.('Ink background is unavailable on this device. Music playback is unchanged.');
    console.warn('Ink background:', error);
  }

  initGraphics() {
    if (this.gl) return;
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: true, depth: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL is unavailable');
    const shader = (type, source) => {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(result);
        gl.deleteShader(result);
        throw new Error(message);
      }
      return result;
    };
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}');
    const fragment = shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform vec2 resolution;
      uniform float time;
      uniform vec3 tint;
      uniform vec2 flow;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p); f=f*f*f*(f*(f*6.-15.)+10.);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
      }
      float fbm(vec2 p) {
        float value=0., weight=.5;
        for(int i=0;i<4;i++) { value+=weight*noise(p); p=mat2(.8,-.6,.6,.8)*p*1.92+3.7; weight*=.5; }
        return value;
      }
      void main() {
        vec2 uv=gl_FragCoord.xy/resolution;
        vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.)*2.05;
        float t=time*.25;
        // Advect the noise through a continuously turning vector field. Audio steers
        // only the smoothed drift velocity so the motion reads as calm liquid ink.
        vec2 across=vec2(-flow.y,flow.x);
        vec2 q=vec2(fbm(p+flow+across*.16),fbm(p+vec2(4.8)+flow*.68-across*.20));
        vec2 r=vec2(fbm(p+2.4*q+vec2(1.7)+flow*.30),fbm(p+2.4*q+vec2(8.3)-flow*.25));
        float density=fbm(p+2.6*r);
        float left=exp(-length((uv-vec2(.20+.07*sin(t),.38+.11*cos(t*.8)))*vec2(1.85,1.45))*1.95);
        float right=exp(-length((uv-vec2(.82,.62+.10*sin(t*.7)))*vec2(1.75,1.5))*1.95);
        float cloud=smoothstep(.30,.78,density)*(left+right);
        vec3 cool=mix(vec3(.10,.26,.34),tint.bgr*.48,.5);
        vec3 pigment=mix(cool,tint,smoothstep(.22,.78,r.y+uv.x*.28));
        float light=cloud*.42;
        float vignette=1.-.42*length(uv-.5);
        float opacity=clamp(light*vignette,0.,.74);
        float dither=(hash(gl_FragCoord.xy+fract(time))-hash(gl_FragCoord.yx+19.31))*(1.5/255.);
        vec3 col=clamp(pigment*opacity+dither,0.,1.);
        gl_FragColor=vec4(col,clamp(opacity+dither,0.,1.));
      }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(['resolution', 'time', 'tint', 'flow'].map((key) => [key, gl.getUniformLocation(program, key)]));
    this.gl = gl;
  }

  async start(audioReady = false) {
    if (!this.enabled || this.failed || this.audio.paused || document.hidden || this.frame || this.starting) return;
    this.starting = true;
    try {
      this.initGraphics();
      if (!audioReady && !await this.prepareAudio()) return;
      if (!this.enabled || this.audio.paused || document.hidden) return;
      document.body.classList.add('ink-active');
      this.canvas.classList.add('visible');
      this.lastTime = 0;
      this.frame = requestAnimationFrame((now) => this.draw(now));
    } catch (error) {
      this.handleAudioError(error);
    } finally { this.starting = false; }
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastTime = 0;
    this.canvas.classList.remove('visible');
    document.body.classList.remove('ink-active');
    // Never suspend/disconnect the media source: it is also the audible playback route.
  }

  resetSignal() {
    this.energy = [0, 0, 0];
    this.bandPeaks = [0.01, 0.004, 0.001];
    this.level = 0;
    this.flowTurn = 0;
    this.flowSpeed = 0.05;
  }

  updateSignal(dt) {
    this.analyser.getFloatFrequencyData(this.bins);
    this.analyser.getFloatTimeDomainData(this.waveform);
    let power = 0;
    for (const value of this.waveform) power += value * value;
    const rms = Math.sqrt(power / this.waveform.length);
    const audible = !this.audio.muted && this.audio.volume > 0 && rms > 0.0005;
    // RMS gates silence; do not multiply the analysed signal by volume a second time.
    const loudness = audible ? Math.min(1, Math.sqrt(rms * 3)) : 0;
    this.level += (loudness - this.level) * (1 - Math.exp(-dt * (loudness > this.level ? 14 : 5)));
    const band = (low, high) => {
      const hz = this.context.sampleRate / this.analyser.fftSize;
      const start = Math.max(1, Math.floor(low / hz));
      const end = Math.min(this.bins.length, Math.ceil(high / hz));
      let sum = 0;
      // Linear power preserves dynamics that byte-scaled decibels flatten out.
      for (let i = start; i < end; i++) sum += Math.pow(10, this.bins[i] / 10);
      return end > start && audible ? Math.sqrt(sum / (end - start)) : 0;
    };
    const floors = [0.002, 0.0008, 0.0002];
    const levels = this.levels ||= [0, 0, 0];
    levels[0] = band(35, 180);
    levels[1] = band(180, 2400);
    levels[2] = band(2400, 12000);
    for (let i = 0; i < 3; i++) {
      const value = levels[i];
      this.bandPeaks[i] = Math.max(floors[i], value, this.bandPeaks[i] * Math.exp(-dt * .3));
      levels[i] = Math.min(1, value / this.bandPeaks[i]) * Math.min(1, loudness * 2);
    }
    for (let i = 0; i < 3; i++) {
      const value = this.energy[i];
      this.energy[i] = value + (levels[i] - value) * (1 - Math.exp(-dt * (levels[i] > value ? 12 : 4.5)));
    }
  }

  draw(now) {
    if (!this.enabled || this.audio.paused || document.hidden || !this.gl) { this.stop(); return; }
    this.frame = requestAnimationFrame((next) => this.draw(next));
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, .05) : 1 / 60;
    this.lastTime = now;
    this.updateSignal(dt);
    const motionScale = this.motion.matches ? .15 : 1;
    // Smooth, calm velocity modulation: clearly glides faster during energetic passages
    // and settles gently during quiet passages, with heavy inertia so it never shakes.
    const targetSpeed = .05 + this.energy[0] * .42 + this.level * .14 + this.energy[1] * .10;
    const speedEase = targetSpeed > this.flowSpeed ? 4.2 : 2.0;
    this.flowSpeed += (targetSpeed - this.flowSpeed) * (1 - Math.exp(-dt * speedEase));
    this.time += dt * (.22 + this.flowSpeed * .52) * motionScale;
    this.directionTime += dt * motionScale;
    const desiredTurn = Math.sin(this.directionTime * .20) * .15
      + (this.energy[1] - this.energy[2]) * .14;
    this.flowTurn += (desiredTurn - this.flowTurn) * (1 - Math.exp(-dt * 1.1));
    this.flowAngle += this.flowTurn * dt * motionScale;
    const step = this.flowSpeed * 1.35 * motionScale * dt;
    this.flow[0] += Math.cos(this.flowAngle) * step;
    this.flow[1] += Math.sin(this.flowAngle) * step;
    const dpr = Math.min(typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1, 1.35);
    const scale = Math.min(dpr, 1600 / Math.max(1, innerWidth));
    const width = Math.max(1, Math.round(innerWidth * scale));
    const height = Math.max(1, Math.round(innerHeight * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
    const gl = this.gl, u = this.uniforms;
    gl.uniform2f(u.resolution, width, height);
    gl.uniform1f(u.time, this.time);
    gl.uniform3fv(u.tint, this.color);
    gl.uniform2fv(u.flow, this.flow);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
