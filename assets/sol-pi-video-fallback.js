(() => {
  function init() {
    document.querySelectorAll('video[data-fallback-src]').forEach((video) => {
      if (video.dataset.fallbackReady) return;
      video.dataset.fallbackReady = 'true';
      const figure = video.closest('figure');
      const link = figure?.querySelector('[data-video-fallback]');
      const status = figure?.querySelector('[data-video-status]');
      let switched = false;
      let timer;
      let wantsPlay = false;
      let lastTime = 0;
      const clear = () => { clearTimeout(timer); timer = undefined; };
      const fallback = () => {
        if (switched) return;
        switched = true;
        clear();
        const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const resume = wantsPlay || !video.paused;
        if (status) status.textContent = 'Using the backup video source.';
        video.addEventListener('loadedmetadata', () => {
          if (position > 0) video.currentTime = Math.min(position, video.duration || position);
          if (resume) video.play().catch(() => {
            if (status) status.textContent = 'Backup video ready. Press play to continue.';
          });
        }, {once: true});
        video.src = video.dataset.fallbackSrc;
        video.load();
      };
      const arm = () => {
        if (!switched && wantsPlay && !timer) timer = setTimeout(fallback, 12000);
      };
      video.addEventListener('play', () => { wantsPlay = true; lastTime = video.currentTime; arm(); });
      video.addEventListener('pause', () => { wantsPlay = false; clear(); });
      video.addEventListener('ended', clear);
      video.addEventListener('waiting', arm);
      video.addEventListener('stalled', arm);
      video.addEventListener('timeupdate', () => {
        if (video.currentTime !== lastTime) { lastTime = video.currentTime; clear(); arm(); }
      });
      video.addEventListener('error', () => {
        if (!switched) fallback();
        else if (status) status.textContent = 'Video unavailable. Try the download link below.';
      });
      video.querySelectorAll('source').forEach(source => source.addEventListener('error', fallback));
      link?.addEventListener('click', (event) => {
        if (!switched) { event.preventDefault(); fallback(); }
      });
      if (video.error || video.networkState === 3) fallback();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();
})();
