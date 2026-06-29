# Reverse proxy + SSO

ghostdev speaks plain HTTP on localhost and proxies a websocket under `/tty`. Any reverse proxy
works as long as it (a) terminates TLS, (b) forwards websocket upgrades, and (c) enforces auth.

Replace `term.example.com` with your domain and point the proxy at the ghostdev host/port
(default `127.0.0.1:7680`, or the container's published address).

## Caddy (easiest — automatic TLS)

```caddy
term.example.com {
    # Built-in auth (or delegate to forward_auth / an SSO provider — see below).
    basic_auth {
        # generate the hash with:  caddy hash-password
        ghost $2a$14$......your-bcrypt-hash......
    }
    reverse_proxy 127.0.0.1:7680
}
```

Caddy forwards websockets automatically, so `/tty` just works.

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name term.example.com;
    ssl_certificate     /etc/letsencrypt/live/term.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/term.example.com/privkey.pem;

    # Minimum bar: HTTP basic auth (htpasswd). Prefer forward-auth/SSO below.
    auth_basic           "ghostdev";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:7680;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # websocket for /tty
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

## SSO (Authentik / Authelia / oauth2-proxy / Cloudflare Access)

For a single identity provider in front of ghostdev, use **forward-auth**: the proxy fires an
auth subrequest to the IdP and only proxies to ghostdev on success. The exact snippet depends on
the IdP, but the shape is always:

```
browser → reverse proxy
   └─ auth subrequest → IdP   (401/redirect to login if no session; 200/204 if logged in)
        └─ on success → proxy to ghostdev (127.0.0.1:7680)
```

- **Authentik / Authelia:** add their forward-auth snippet to the proxy host. Make sure the
  auth-request location itself is exempt from auth (don't gate the IdP's own callback path), or
  you get a redirect loop.
- **Cloudflare Access / Tunnel:** put ghostdev behind a Tunnel and require an Access policy. No
  inbound ports at all.
- **oauth2-proxy:** run it in front and `reverse_proxy` to ghostdev after it sets the session.

Because everything (including the `/tty` websocket) lives under a single origin, gating the root
path covers the whole app.
