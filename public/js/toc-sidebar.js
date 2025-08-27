// TOC Sidebar Functionality
document.addEventListener('DOMContentLoaded', function() {
    const progressBar = document.getElementById('reading-progress-bar');
    const tocLinks = document.querySelectorAll('.toc-nav a');
    const tocSidebar = document.getElementById('toc-sidebar');
    const tocToggle = document.getElementById('toc-toggle');
    
    // Update reading progress
    function updateReadingProgress() {
        if (!progressBar) return;
        
        const article = document.querySelector('.post-content');
        if (!article) return;
        
        const articleHeight = article.offsetHeight;
        const articleTop = article.offsetTop;
        const scrollPosition = window.scrollY;
        const windowHeight = window.innerHeight;
        
        const progress = Math.max(0, Math.min(100, 
            ((scrollPosition - articleTop + windowHeight * 0.5) / articleHeight) * 100
        ));
        
        progressBar.style.width = progress + '%';
    }
    
    // Highlight active TOC link
    function updateActiveTocLink() {
        const headers = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        let activeHeader = null;
        
        headers.forEach(header => {
            const rect = header.getBoundingClientRect();
            if (rect.top <= 100) {
                activeHeader = header;
            }
        });
        
        // Remove active class from all links
        tocLinks.forEach(link => {
            link.classList.remove('active');
            link.style.color = '';
            link.style.fontWeight = '';
        });
        
        // Add active class to current link
        if (activeHeader && activeHeader.id) {
            const activeLink = document.querySelector(`.toc-nav a[href="#${activeHeader.id}"]`);
            if (activeLink) {
                activeLink.classList.add('active');
                activeLink.style.color = 'var(--primary)';
                activeLink.style.fontWeight = '500';
            }
        }
    }
    
    // Smooth scrolling for TOC links
    tocLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href').substring(1);
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                const offsetTop = targetElement.offsetTop - 80;
                window.scrollTo({
                    top: offsetTop,
                    behavior: 'smooth'
                });
            }
        });
    });
    
    // Update on scroll
    let ticking = false;
    function onScroll() {
        if (!ticking) {
            requestAnimationFrame(function() {
                updateReadingProgress();
                updateActiveTocLink();
                ticking = false;
            });
            ticking = true;
        }
    }
    
    window.addEventListener('scroll', onScroll);
    
    // TOC Toggle functionality
    if (tocToggle && tocSidebar) {
        // Check localStorage for saved state
        const isCollapsed = localStorage.getItem('toc-collapsed') === 'true';
        if (isCollapsed) {
            tocSidebar.classList.add('collapsed');
            const toggleSpan = tocToggle.querySelector('span');
            if (toggleSpan) toggleSpan.textContent = '›';
        }
        
        tocToggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const isCurrentlyCollapsed = tocSidebar.classList.contains('collapsed');
            const toggleSpan = tocToggle.querySelector('span');
            
            if (isCurrentlyCollapsed) {
                tocSidebar.classList.remove('collapsed');
                if (toggleSpan) toggleSpan.textContent = '‹';
                localStorage.setItem('toc-collapsed', 'false');
            } else {
                tocSidebar.classList.add('collapsed');
                if (toggleSpan) toggleSpan.textContent = '›';
                localStorage.setItem('toc-collapsed', 'true');
            }
        });
    }
    
    // Initial update
    updateReadingProgress();
    updateActiveTocLink();
});