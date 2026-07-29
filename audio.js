(function () {
  class QuizArenaAudio {
    constructor() {
      this.unlocked = false;
      this.muted = false;
      this.currentAudio = null;
      this.activeSfx = []; // Tracks all running sound effects
      this.ytPlayer = null;
      this.ytReady = false;
      this.pendingYouTube = null;
      this.ensureYouTubeApi();
    }

    unlock() {
      this.unlocked = true;
      try {
        const a = new Audio();
        a.volume = 0;
        a.muted = true;
        a.play().catch(function () {});
      } catch (err) {}
    }

    setMuted(value) {
      this.muted = !!value;
      if (this.currentAudio) this.currentAudio.muted = this.muted;
      this.activeSfx.forEach(sfx => { if (sfx) sfx.muted = this.muted; });
      if (this.ytPlayer && this.ytPlayer.mute && this.ytPlayer.unMute) {
        try {
          this.muted ? this.ytPlayer.mute() : this.ytPlayer.unMute();
        } catch (err) {}
      }
    }

    // Instantly stops ALL music AND running sound effects
    stopAll() {
      if (this.currentAudio) {
        try {
          this.currentAudio.pause();
          this.currentAudio.currentTime = 0;
        } catch (err) {}
        this.currentAudio = null;
      }
      
      if (this.activeSfx && this.activeSfx.length) {
        this.activeSfx.forEach(sfx => {
          try {
            sfx.pause();
            sfx.currentTime = 0;
          } catch (err) {}
        });
        this.activeSfx = [];
      }

      this.destroyYouTubePlayer();
    }

    stopMusic() {
      this.stopAll();
    }

    playMusic(value, loop, startTime) {
      const media = this.parseMedia(value);
      if (!media.value || !this.unlocked || this.muted) return;
      if (media.type === 'youtube') return this.playYouTube(media.value, loop !== false, startTime);
      
      this.stopAll(); // Kill any playing audio or SFX before starting new music

      try {
        const audio = new Audio(media.value);
        audio.loop = loop !== false;
        audio.volume = 0.55;
        audio.muted = this.muted;
        audio.preload = 'auto';
        if (startTime && !isNaN(startTime)) {
          audio.currentTime = startTime;
        }
        audio.addEventListener('error', function () { console.error('Music source failed:', media.value, audio.error); });
        audio.play().catch(function (err) { console.error('Music playback failed:', media.value, err); });
        this.currentAudio = audio;
      } catch (err) {
        console.error('Music setup failed:', media.value, err);
      }
    }

    playSfx(value, startTime) {
      const media = this.parseMedia(value);
      if (!media.value || !this.unlocked || this.muted) return;
      if (media.type === 'youtube') return;

      try {
        const audio = new Audio(media.value);
        audio.volume = 0.85;
        audio.muted = this.muted;
        audio.preload = 'auto';
        if (startTime && !isNaN(startTime)) {
          audio.currentTime = startTime;
        }
        
        // Track active SFX instance so it can be killed on skip
        this.activeSfx.push(audio);
        
        const cleanup = () => {
          const idx = this.activeSfx.indexOf(audio);
          if (idx !== -1) this.activeSfx.splice(idx, 1);
        };

        audio.addEventListener('ended', cleanup);
        audio.addEventListener('error', () => {
          console.error('SFX source failed:', media.value, audio.error);
          cleanup();
        });

        audio.play().catch(err => {
          console.error('SFX playback failed:', media.value, err);
          cleanup();
        });
      } catch (err) {
        console.error('SFX setup failed:', media.value, err);
      }
    }

    parseMedia(value) {
      const raw = String(value || '').trim();
      if (!raw) return { type: '', value: '' };
      const youtubeId = this.extractYouTubeId(raw);
      if (youtubeId) return { type: 'youtube', value: youtubeId };
      const driveId = this.extractGoogleDriveId(raw);
      if (driveId) {
        return { type: 'audio', value: 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(driveId) };
      }
      return { type: 'audio', value: raw };
    }

    extractYouTubeId(value) {
      const text = String(value || '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;
      const patterns = [
        /youtu\.be\/([^?&#/]+)/i,
        /youtube\.com\/watch\?.*?[?&]v=([^&#]+)/i,
        /youtube\.com\/embed\/([^?&#/]+)/i,
        /youtube\.com\/shorts\/([^?&#/]+)/i,
        /youtube\.com\/live\/([^?&#/]+)/i,
        /[?&]v=([^&#]+)/i
      ];
      for (let i = 0; i < patterns.length; i++) {
        const match = text.match(patterns[i]);
        if (match && match[1]) return decodeURIComponent(match[1]).replace(/[^a-zA-Z0-9_-]/g, '');
      }
      return '';
    }

    extractGoogleDriveId(value) {
      const text = String(value || '').trim();
      if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
      const patterns = [
        /drive\.google\.com\/file\/d\/([^/]+)/i,
        /drive\.google\.com\/open\?id=([^&]+)/i,
        /drive\.google\.com\/uc\?[^#]*id=([^&]+)/i,
        /docs\.google\.com\/uc\?[^#]*id=([^&]+)/i
      ];
      for (let i = 0; i < patterns.length; i++) {
        const match = text.match(patterns[i]);
        if (match && match[1]) return decodeURIComponent(match[1]).trim();
      }
      return '';
    }

    ensureYouTubeApi() {
      if (window.YT && window.YT.Player) { this.ytReady = true; return; }
      if (!document.getElementById('youtube-iframe-api')) {
        const tag = document.createElement('script');
        tag.id = 'youtube-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      const self = this;
      const previousHandler = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function() {
        if (typeof previousHandler === 'function') {
          try { previousHandler(); } catch (err) {}
        }
        self.ytReady = true;
        if (self.pendingYouTube) {
          const next = self.pendingYouTube;
          self.pendingYouTube = null;
          self.playYouTube(next.videoId, next.loop, next.startTime);
        }
      };
    }

    getYouTubeContainer() {
      let container = document.getElementById('yt-audio-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'yt-audio-container';
        container.style.cssText = 'position:fixed;left:0;bottom:0;width:200px;height:200px;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden;';
        document.body.appendChild(container);
      }
      return container;
    }

    createYouTubeMount() {
      const container = this.getYouTubeContainer();
      container.innerHTML = '';
      const mount = document.createElement('div');
      const mountId = 'yt-audio-player-' + Date.now();
      mount.id = mountId;
      container.appendChild(mount);
      return mountId;
    }

    destroyYouTubePlayer() {
      if (this.ytPlayer) {
        try {
          if (this.ytPlayer.stopVideo) this.ytPlayer.stopVideo();
          if (this.ytPlayer.destroy) this.ytPlayer.destroy();
        } catch (err) {}
        this.ytPlayer = null;
      }
      const container = document.getElementById('yt-audio-container');
      if (container) {
        try { container.innerHTML = ''; } catch (err) {}
      }
    }

    playYouTube(videoId, loop, startTime) {
      const cleanVideoId = this.extractYouTubeId(videoId) || String(videoId || '').trim();
      if (!cleanVideoId || !this.unlocked || this.muted) return;
      this.stopAll();
      if (!this.ytReady || !(window.YT && window.YT.Player)) {
        this.pendingYouTube = { videoId: cleanVideoId, loop: loop, startTime: startTime };
        this.ensureYouTubeApi();
        return;
      }
      const mountId = this.createYouTubeMount();
      const self = this;
      try {
        this.ytPlayer = new YT.Player(mountId, {
          height: '200',
          width: '200',
          videoId: cleanVideoId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            playsinline: 1,
            rel: 0,
            start: startTime || 0,
            loop: loop ? 1 : 0,
            playlist: loop ? cleanVideoId : undefined
          },
          events: {
            onReady: function(event) {
              try {
                self.muted ? event.target.mute() : event.target.unMute();
                event.target.setVolume(55);
                if (startTime) event.target.seekTo(startTime);
                event.target.playVideo();
              } catch (err) {
                console.error('YouTube playback failed:', err);
              }
            },
            onStateChange: function(event) {
              if (loop && window.YT && event.data === YT.PlayerState.ENDED) {
                try {
                  event.target.seekTo(startTime || 0);
                  event.target.playVideo();
                } catch (err) {}
              }
            },
            onError: function(event) {
              console.error('YouTube player error:', event && event.data);
            }
          }
        });
      } catch (err) {
        console.error('YouTube player setup failed:', err);
      }
    }
  }

  window.QuizArenaAudio = QuizArenaAudio;
})();
