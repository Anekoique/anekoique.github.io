/**
 * Dynamic starfield — generates stars as a single canvas layer for
 * much better performance than many DOM nodes + CSS animations.
 */
(function () {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return; // respect user preference
    }

    const STAR_COLORS = [
        '255, 255, 255',
        '255, 248, 231',
        '255, 236, 208',
        '232, 236, 255',
        '216, 224, 255',
        '255, 244, 214',
    ];

    // Density: stars per 100k px². Lower than before since canvas is cheaper per star.
    const DENSITY = 0.00007;

    function rand(min, max) { return Math.random() * (max - min) + min; }
    function pick(arr)      { return arr[Math.floor(Math.random() * arr.length)]; }

    function setup() {
        // Only run in dark mode — no point spending cycles on light.
        const isDark = () => document.body.classList.contains('dark');

        const canvas = document.createElement('canvas');
        canvas.className = 'starfield';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = [
            'position:fixed',
            'top:0',
            'left:0',
            'width:100vw',
            'height:100vh',
            'pointer-events:none !important',
            'user-select:none',
            'z-index:-1',  // sit behind everything
        ].join(';');
        document.body.insertBefore(canvas, document.body.firstChild);

        const ctx = canvas.getContext('2d', { alpha: true });
        let stars = [];
        let width = 0, height = 0, dpr = 1;
        let rafId = null;
        let lastTime = 0;

        function resize() {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            width  = window.innerWidth;
            height = window.innerHeight;
            canvas.width  = width  * dpr;
            canvas.height = height * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset + set scale

            const count = Math.max(40, Math.floor(width * height * DENSITY));
            stars = new Array(count).fill(0).map(() => {
                const roll = Math.random();
                // 8 % bright "hero" stars (larger + haloed + pulsing size),
                // 25 % glow stars (medium, subtle halo),
                // rest tiny background stars
                const tier = roll < 0.08 ? 2 : roll < 0.33 ? 1 : 0;
                const baseR = tier === 2 ? rand(1.6, 2.4)
                           :  tier === 1 ? rand(1.1, 1.6)
                           :               rand(0.5, 1.0);
                return {
                    x: rand(0, width),
                    y: rand(0, height),
                    r: baseR,
                    tier: tier,
                    c: pick(STAR_COLORS),
                    min: rand(0.2, 0.45),
                    max: rand(0.85, 1),
                    period: rand(2000, 6000),
                    phase: rand(0, 6.283),
                    /* size-pulse on a separate (slower) cycle so scale + opacity
                       are out of phase, giving a "breathing" feel */
                    sizePhase: rand(0, 6.283),
                    sizePeriod: rand(3500, 7000),
                };
            });
        }

        function frame(ts) {
            if (!isDark()) {
                ctx.clearRect(0, 0, width, height);
                rafId = null;
                return;
            }

            // Throttle to ~30 fps — twinkle doesn't need 60.
            if (ts - lastTime < 33) {
                rafId = requestAnimationFrame(frame);
                return;
            }
            lastTime = ts;

            ctx.clearRect(0, 0, width, height);

            // Additive blending so star halos sum instead of overwrite.
            ctx.globalCompositeOperation = 'lighter';

            for (let i = 0; i < stars.length; i++) {
                const s = stars[i];
                const t = (ts / s.period) * 2 * Math.PI + s.phase;
                const brightness = s.min + (s.max - s.min) * (0.5 + 0.5 * Math.sin(t));
                const ts2 = (ts / s.sizePeriod) * 2 * Math.PI + s.sizePhase;
                const sizeMul = 0.85 + 0.3 * (0.5 + 0.5 * Math.sin(ts2));
                const r = s.r * sizeMul;
                const color = s.c;

                if (s.tier >= 1) {
                    // Gentle glow halo — subtle aura around the star
                    const haloR = r * (s.tier === 2 ? 3.5 : 2.2);
                    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, haloR);
                    grad.addColorStop(0,    `rgba(${color}, ${brightness * 0.35})`);
                    grad.addColorStop(0.4,  `rgba(${color}, ${brightness * 0.1})`);
                    grad.addColorStop(1,    `rgba(${color}, 0)`);
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, haloR, 0, 6.283);
                    ctx.fill();
                }

                // Solid core dot on top of halo
                ctx.fillStyle = `rgba(${color}, ${brightness})`;
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, 6.283);
                ctx.fill();

                // Subtle diffraction cross for hero stars
                if (s.tier === 2 && brightness > 0.85) {
                    const crossLen = r * 2.5;
                    const crossAlpha = (brightness - 0.85) * 1.2;
                    ctx.strokeStyle = `rgba(${color}, ${crossAlpha})`;
                    ctx.lineWidth = 0.3;
                    ctx.beginPath();
                    ctx.moveTo(s.x - crossLen, s.y);
                    ctx.lineTo(s.x + crossLen, s.y);
                    ctx.moveTo(s.x, s.y - crossLen);
                    ctx.lineTo(s.x, s.y + crossLen);
                    ctx.stroke();
                }
            }

            // Restore default so nothing else in the page inherits it.
            ctx.globalCompositeOperation = 'source-over';
            rafId = requestAnimationFrame(frame);
        }

        function start() {
            if (rafId == null) rafId = requestAnimationFrame(frame);
        }

        resize();
        start();

        // Debounced resize.
        let rt;
        window.addEventListener('resize', () => {
            clearTimeout(rt);
            rt = setTimeout(() => { resize(); start(); }, 150);
        });

        // Pause when tab is hidden.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            } else {
                start();
            }
        });

        // React to theme toggle — restart the loop when switching to dark.
        const observer = new MutationObserver(() => {
            if (isDark()) start();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
