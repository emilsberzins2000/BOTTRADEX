const API_BASE = localStorage.getItem("bottradex_api_base") || "https://bottradex-backendv1.onrender.com";
const tokenKey = "bottradex_token";
const userKey = "bottradex_user";

function getToken(){ return localStorage.getItem(tokenKey) || ""; }
function getUser(){ try { return JSON.parse(localStorage.getItem(userKey) || "null"); } catch { return null; } }
function setSession(token, user){ localStorage.setItem(tokenKey, token); localStorage.setItem(userKey, JSON.stringify(user)); }
function clearSession(){ localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); }
function authHeaders(){
  const token = getToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}
async function api(path, options={}){
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers||{}), ...authHeaders() },
    ...options
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `Request failed ${res.status}`);
  return data;
}
function money(v){
  if(v == null || Number.isNaN(Number(v))) return "€--";
  return new Intl.NumberFormat("en-IE",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(Number(v));
}
function pct(v){
  if(v == null || Number.isNaN(Number(v))) return "--";
  return `${Number(v).toFixed(2)}%`;
}
function qs(sel, root=document){ return root.querySelector(sel); }
function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
function setText(id, value){ const el = document.getElementById(id); if(el) el.textContent = value; }
function navActive(){
  const page = location.pathname.split("/").pop() || "index.html";
  qsa(".nav-links a").forEach(a => {
    if(a.getAttribute("href") === page) a.classList.add("active");
  });
  const authBtn = document.getElementById("nav-auth");
  if(authBtn){
    const user = getUser();
    authBtn.textContent = user ? `Logout ${user.username}` : "Login";
    authBtn.onclick = () => {
      if(user){ clearSession(); location.href = "login.html"; }
      else location.href = "login.html";
    };
  }
}
async function requireAuth(redirect=true){
  const token = getToken();
  if(!token){
    if(redirect) location.href = "login.html";
    return null;
  }
  try{
    const data = await api("/api/auth/me");
    setSession(token, data.user);
    return data.user;
  }catch{
    clearSession();
    if(redirect) location.href = "login.html";
    return null;
  }
}
function connectSocket(onMessage){
  try{
    const ws = new WebSocket(API_BASE.replace(/^http/,"ws"));
    ws.onmessage = ev => {
      try{ onMessage(JSON.parse(ev.data)); } catch {}
    };
    return ws;
  } catch { return null; }
}
