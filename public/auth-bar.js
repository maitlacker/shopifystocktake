// Injected into every page — shows logged-in user + sign out in the header
(function () {
  fetch('/api/me')
    .then((r) => {
      if (r.status === 401) { window.location.href = '/login'; return null; }
      return r.json();
    })
    .then((user) => {
      if (!user) return;

      const header = document.querySelector('header .header-inner');
      if (!header) return;

      const bar = document.createElement('div');
      bar.className = 'auth-bar';
      bar.innerHTML = `
        <span class="auth-user">
          ${user.photo ? `<img src="${user.photo}" class="auth-avatar" alt="" />` : ''}
          <span class="auth-name">${user.displayName || user.email}</span>
        </span>
        <form action="/logout" method="POST" style="display:inline">
          <button type="submit" class="btn btn-ghost auth-signout">Sign out</button>
        </form>
      `;
      header.appendChild(bar);
    })
    .catch(() => {});
})();
