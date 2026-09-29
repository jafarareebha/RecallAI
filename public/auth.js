// Recall auth (front-end demo). Accounts live in this browser's localStorage.
// For production, replace signup/login/logout with calls to a real backend.
(function () {
  const USERS = "recall_users", SESSION = "recall_session";
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

  async function hash(pw, salt) {
    const data = new TextEncoder().encode(salt + ":" + pw);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381; for (const b of data) h = ((h << 5) + h + b) >>> 0; return "x" + h; // fallback
  }
  const salt = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const Auth = {
    session: () => read(SESSION, null),
    async signup(name, email, pw) {
      email = email.trim().toLowerCase();
      const users = read(USERS, {});
      if (users[email]) throw new Error("An account with this email already exists.");
      const s = salt();
      users[email] = { name: name.trim(), salt: s, hash: await hash(pw, s) };
      localStorage.setItem(USERS, JSON.stringify(users));
      localStorage.setItem(SESSION, JSON.stringify({ email, name: users[email].name }));
    },
    async login(email, pw) {
      email = email.trim().toLowerCase();
      const u = read(USERS, {})[email];
      if (!u || (await hash(pw, u.salt)) !== u.hash) throw new Error("Invalid email or password.");
      localStorage.setItem(SESSION, JSON.stringify({ email, name: u.name }));
    },
    logout() { localStorage.removeItem(SESSION); location.href = "login.html"; },
    requireAuth() { if (!Auth.session()) { location.replace("login.html"); return false; } return true; },
    redirectIfAuthed() { if (Auth.session()) { location.replace("chat.html"); return true; } return false; }
  };
  window.Auth = Auth;

  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.dataset.auth === "guest") return; // login page: no nav changes
    const user = Auth.session();

    // Route every "Get Started" / "Start Building Memory" button
    document.querySelectorAll("a").forEach(a => {
      if (/get started|start building memory/i.test(a.textContent)) a.href = user ? "chat.html" : "login.html";
    });

    // Logout button in the navigation bar
    const actions = document.querySelector("header > div > div:last-child");
    if (user && actions && !actions.querySelector("[data-logout]")) {
      const btn = document.createElement("button");
      btn.setAttribute("data-logout", "");
      btn.className = "font-body-sm text-body-sm px-4 py-2 rounded-lg bg-surface-container-high text-on-surface border border-outline-variant/50 hover:border-error hover:text-error transition-all active:scale-95 flex items-center gap-1.5";
      btn.innerHTML = '<span class="material-symbols-outlined text-body-sm">logout</span><span class="font-medium">Logout</span>';
      btn.onclick = Auth.logout;
      actions.appendChild(btn);
    }
  });
})();
