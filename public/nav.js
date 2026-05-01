// Shared navigation — injected into every page's <header>
(function () {
  const path = window.location.pathname;

  const NAV_ITEMS = [
    {
      label: 'Stocktake',
      children: [
        { label: 'Stocktake',               href: '/' },
        { label: 'Order Picking',           href: '/picking.html' },
        { label: 'Discrepancy Report',      href: '/discrepancies.html' },
        { label: 'Draft & Archived Stock',  href: '/draft-report.html' },
        { label: 'History',                 href: '/history.html' },
      ],
    },
    {
      label: 'Reports',
      children: [
        { label: 'Sales Velocity',        href: '/velocity.html' },
        { label: 'Shopify Daily Report',  href: '/shopify-report.html' },
        { label: 'Google Ads',            href: '/google-ads.html' },
        { label: 'Picking Performance',   href: '/picking-report.html' },
      ],
    },
    {
      label: 'Scanner',
      children: [
        { label: 'Scan Label',       href: '/label-scanner.html' },
        { label: 'Reference Images', href: '/label-reference.html' },
        { label: 'Scan History',     href: '/scan-history.html' },
      ],
    },
    {
      label: 'Syncing',
      children: [
        { label: 'Manage Syncs', href: '/syncing.html' },
      ],
    },
    {
      label: 'Marketing',
      children: [
        { label: 'Coupon Export',    href: '/coupon-export.html' },
        { label: 'Gift Card Export', href: '/gift-card-export.html' },
        { label: 'Margin Tagger',    href: '/margin-tagger.html' },
      ],
    },
  ];

  function isGroupActive(children) {
    return children.some((c) =>
      c.href === '/' ? path === '/' : path.endsWith(c.href)
    );
  }

  function isItemActive(href) {
    return href === '/' ? path === '/' : path.endsWith(href);
  }

  const dropdownsHtml = NAV_ITEMS.map((group) => `
    <div class="nav-dropdown${isGroupActive(group.children) ? ' nav-dropdown--active' : ''}">
      <button class="nav-btn" aria-haspopup="true" aria-expanded="false">
        ${group.label}<span class="nav-caret">&#9660;</span>
      </button>
      <div class="nav-dropdown-menu">
        ${group.children.map((c) => `
          <a href="${c.href}" class="nav-dropdown-item${isItemActive(c.href) ? ' nav-dropdown-item--active' : ''}">${c.label}</a>
        `).join('')}
      </div>
    </div>
  `).join('');

  const header = document.querySelector('header');
  if (header) {
    header.innerHTML = `
      <div class="header-inner">
        <a href="/" class="site-title">The Self Styler WMS</a>
        <nav class="main-nav">${dropdownsHtml}</nav>
        <div class="nav-user">
          <span id="nav-user-name" class="nav-user-name"></span>
          <form action="/logout" method="POST" style="display:inline">
            <button type="submit" class="nav-signout-btn">Sign out</button>
          </form>
        </div>
      </div>
    `;
  }

  // Fetch logged-in user
  fetch('/api/me')
    .then((r) => {
      if (r.status === 401) { window.location.href = '/login'; return null; }
      return r.json();
    })
    .then((user) => {
      if (!user) return;
      const nameEl = document.getElementById('nav-user-name');
      if (!nameEl) return;
      if (user.photo) {
        nameEl.insertAdjacentHTML('beforebegin',
          `<img src="${user.photo}" class="nav-avatar" alt="" />`);
      }
      nameEl.textContent = user.displayName || user.email;
    })
    .catch(() => {});

  // Dropdown open/close on click
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn) {
      e.stopPropagation();
      const dropdown = btn.closest('.nav-dropdown');
      const isOpen = dropdown.classList.contains('open');
      document.querySelectorAll('.nav-dropdown.open').forEach((d) => {
        d.classList.remove('open');
        d.querySelector('.nav-btn').setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        dropdown.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    // Click outside — close all
    document.querySelectorAll('.nav-dropdown.open').forEach((d) => {
      d.classList.remove('open');
      d.querySelector('.nav-btn').setAttribute('aria-expanded', 'false');
    });
  });
})();
