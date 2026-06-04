async function login(username, password) {
  let req = await fetch("/auth", {
    method: "POST",
    headers: { "Content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });
  return await req.json();
}

async function request(url, data = {}) {
  if (!data.method) data.method = "GET";
  if (!data.headers) data.headers = {};
  if (!data.headers["Content-Type"])
    data.headers["Content-Type"] = "application/json";
  data.credentials = "include";
  if (data.body && typeof data.body !== "string") {
    data.body = JSON.stringify(data.body);
  }
  let req = await fetch(url, data);
  return await req.json();
}

const CAS_CONFIG = null;

function googleOAuth() {
  if (CAS_CONFIG) {
    const params = new URLSearchParams({
      client_id: CAS_CONFIG.clientId,
      redirect_uri: CAS_CONFIG.redirectUri,
    });
    window.location.href = `${CAS_CONFIG.serverUrl}/auth/google?${params}`;
  } else {
    window.location.href = "/auth/google";
  }
}

function microsoftOAuth() {
  if (CAS_CONFIG) {
    const params = new URLSearchParams({
      client_id: CAS_CONFIG.clientId,
      redirect_uri: CAS_CONFIG.redirectUri,
    });
    window.location.href = `${CAS_CONFIG.serverUrl}/auth/microsoft?${params}`;
  } else {
    window.location.href = "/auth/microsoft";
  }
}

async function logout() {
  let req = await fetch("/auth", {
    method: "DELETE",
    credentials: "include",
  });
  return await req.json();
}
