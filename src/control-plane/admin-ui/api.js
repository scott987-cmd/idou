// Talking to the console's own server. Every change carries the token this
// sign-in was given; a sign-in that has ended sends the page back to sign in.
let csrf = "";
export const setCsrf = (token) => { csrf = token; };

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || `请求失败（HTTP ${status}）`); this.status = status; this.code = body?.error ?? null; }
}

async function call(method, path, body) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json", "x-idou-csrf": csrf } : method !== "GET" ? { "x-idou-csrf": csrf } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let value = null;
  try { value = await response.json(); } catch { value = null; }
  if (response.status === 401) { window.location.assign("/admin"); throw new ApiError(401, value); }
  if (!response.ok) throw new ApiError(response.status, value);
  return value;
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const api = {
  get: (path, params) => call("GET", `/admin/api/${path}${query(params)}`),
  post: (path, body = {}) => call("POST", `/admin/api/${path}`, body),
  put: (path, body = {}) => call("PUT", `/admin/api/${path}`, body),
  remove: (path) => call("DELETE", `/admin/api/${path}`, {}),
  // A download the browser saves: the same filters, as a link.
  href: (path, params) => `/admin/api/${path}${query(params)}`,
};
