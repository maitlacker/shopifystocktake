// Shared navigation — injected into every page's <header>
(function () {
  const path = window.location.pathname;

  // Admin group is shown only to users on this list
  const ADMIN_ONLY = ['accounts@theselfstyler.com', 'bianca@theselfstyler.com'];

  const NAV_ITEMS = [
    {
      label: 'Warehouse',
      children: [
        { label: 'Stocktake',               href: '/stocktake.html' },
        { label: 'Order Picking',           href: '/picking.html' },
        { label: 'Smart Pick',              href: '/smart-pick.html' },
        { label: 'Order Packing',           href: '/packing.html' },
        { label: 'Discrepancy Report',      href: '/discrepancies.html' },
        { label: 'Draft & Archived Stock',  href: '/draft-report.html' },
        { label: 'Stock Sleuth',            href: '/stock-sleuth.html' },
        { label: 'Stock Receipts',          href: '/stock-receipts.html' },
        { label: 'History',                 href: '/history.html' },
      ],
    },
    {
      label: 'Reports',
      children: [
        { label: 'Sales Velocity',        href: '/velocity.html' },
        { label: 'Velocity Chart',        href: '/velocity-chart.html' },
        { label: 'Sell-Through',          href: '/sell-through.html' },
        { label: 'Total Stock Value',     href: '/total-stock.html' },
        { label: 'Restock Planner',       href: '/restock.html' },
        { label: 'Shopify Daily Report',  href: '/shopify-report.html' },
        { label: 'Google Ads',            href: '/google-ads.html' },
        { label: 'Ads Asset Sync',        href: '/ads-assets.html' },
        { label: 'Sales Reconciliation',  href: '/reconcile.html' },
        { label: 'GST Gap Report',        href: '/gst-gap.html' },
        { label: 'Picking Performance',   href: '/picking-report.html' },
      ],
    },
    {
      label: 'Barcoding',
      children: [
        { label: 'Barcoding',        href: '/barcoding.html' },
        { label: 'Scan Label',       href: '/label-scanner.html' },
        { label: 'Reference Images', href: '/label-reference.html' },
        { label: 'Scan History',     href: '/scan-history.html' },
      ],
    },
    {
      label: 'Production',
      children: [
        { label: 'Production Orders', href: '/production-orders.html' },
        { label: 'Monthly Budgets',   href: '/production-budget.html' },
        { label: 'Suppliers',         href: '/suppliers.html' },
        { label: 'Warehouse Map',     href: '/warehouse-map.html' },
        { label: 'Stock Locations',   href: '/locations.html' },
        { label: 'Location Report',   href: '/location-report.html' },
      ],
    },
    {
      label: 'People',
      children: [
        { label: 'Leave Calendar', href: '/leave-calendar.html' },
        { label: 'Leave Request',  href: '/leave-request.html' },
      ],
    },
    {
      label: 'Customer Service',
      children: [
        { label: 'Incorrect Orders', href: '/incorrect-orders.html' },
      ],
    },
    {
      label: 'Marketing',
      children: [
        { label: 'Influencer Campaigns', href: '/influencers.html' },
        { label: 'Coupon Export',    href: '/coupon-export.html' },
        { label: 'Gift Card Export', href: '/gift-card-export.html' },
        { label: 'Margin Tagger',    href: '/margin-tagger.html' },
        { label: 'EDM Builder',      href: '/edm-builder.html' },
        { label: 'Creative Studio',  href: '/creative-studio.html' },
        { label: 'Creative Review',  href: '/creative-review.html' },
      ],
    },
    {
      label: 'Admin',
      restrict: ADMIN_ONLY,
      children: [
        { label: 'Forecasting',    href: '/forecast.html' },
        { label: 'Asana Sync',     href: '/asana-sync.html' },
        { label: 'BI Dashboard',   href: '/bi-dashboard.html' },
        { label: 'Weekly Pulse',   href: '/weekly-pulse.html' },
        { label: 'Packing Report', href: '/packing-report.html' },
        { label: 'Leave Admin',    href: '/leave-admin.html' },
        { label: 'Manage Syncs',   href: '/syncing.html' },
      ],
    },
  ];

  function isGroupActive(children) {
    return children.some((c) => path.endsWith(c.href));
  }

  function isItemActive(href) {
    return path.endsWith(href);
  }

  const dropdownsHtml = NAV_ITEMS.map((group) => {
    const groupAttr = group.restrict
      ? ` style="display:none" data-restrict-group="${group.restrict.join(',')}"` : '';
    return `
    <div class="nav-dropdown${isGroupActive(group.children) ? ' nav-dropdown--active' : ''}"${groupAttr}>
      <button class="nav-btn" aria-haspopup="true" aria-expanded="false">
        ${group.label}<span class="nav-caret">&#9660;</span>
      </button>
      <div class="nav-dropdown-menu">
        ${group.children.map((c) => {
          const restricted = c.restrict ? ` style="display:none" data-restrict="${c.restrict.join(',')}"` : '';
          const activeCls  = isItemActive(c.href) ? ' nav-dropdown-item--active' : '';
          return `<a href="${c.href}" class="nav-dropdown-item${activeCls}"${restricted}>${c.label}</a>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  const header = document.querySelector('header');
  if (header) {
    header.innerHTML = `
      <div class="header-inner">
        <a href="/" class="site-logo">
          <span class="logo-wordmark">The Self Styler</span>
          <span class="logo-sub">WMS</span>
        </a>
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

  // Fetch logged-in user, then reveal restricted groups and items
  fetch('/api/me')
    .then((r) => {
      if (r.status === 401) { window.location.href = '/login'; return null; }
      return r.json();
    })
    .then((user) => {
      if (!user) return;

      // Reveal restricted nav groups (entire dropdown)
      document.querySelectorAll('[data-restrict-group]').forEach((el) => {
        const allowed = el.dataset.restrictGroup.split(',');
        if (allowed.includes(user.email)) el.style.display = '';
      });

      // Reveal restricted nav items (individual links within a group)
      document.querySelectorAll('[data-restrict]').forEach((el) => {
        const allowed = el.dataset.restrict.split(',');
        if (allowed.includes(user.email)) el.style.display = '';
      });

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
