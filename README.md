# Voice Bridge App

Next.js client for the Ragnar voice bridge. It creates short-lived OpenAI Realtime sessions, performs the WebRTC handshake directly from the browser, and relays audio in both directions.

## Getting Started

### Local dev

```bash
npm install
OPENAI_API_KEY=sk-... npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Connect**. Grant mic permission once and you’ll have a live, full-duplex call. Use **Hang Up** to end the session.

### Required environment variables

| Variable | Scope | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | server | Project key with Realtime access used by `/api/realtime-token` |
| `OPENAI_REALTIME_MODEL` | server (optional) | Overrides the model for the minted session |
| `NEXT_PUBLIC_OPENAI_REALTIME_MODEL` | client (optional) | Forces a client-side model if none returned |
| `NEXT_PUBLIC_OPENAI_REALTIME_CONNECT_URL` | client (optional) | Override if you proxy `/connect` |
| `BASIC_AUTH_USERNAME` | edge (middleware) | Username required to load the app |
| `BASIC_AUTH_PASSWORD` | edge (middleware) | Password required to load the app |

If the BASIC auth vars are unset, the app is public; set them before deploying so only you can connect.

## Realtime WebRTC Notes

1. **Token minting** happens server-side inside `src/app/api/realtime-token/route.ts` by calling `https://api.openai.com/v1/realtime/sessions`. The response contains the `client_secret.value` (ephemeral token) plus the negotiated model.
2. **Client connect** uses that token to call the dedicated `/v1/realtime/connect` endpoint: see `src/app/page.tsx`. The URL defaults to `https://api.openai.com/v1/realtime/connect?model=gpt-4o-realtime-preview-2024-12-17` and can be overridden via env vars.
3. **SDP exchange**: we create an offer, set it locally, POST `Content-Type: application/sdp` to `/connect`, and immediately apply the returned SDP answer. Errors bubble into the UI so we can see when the handshake fails.
4. **Audio streams**: microphone tracks are added to the peer connection and we explicitly create a recv-only transceiver to guarantee the remote audio leg. Incoming `track` events wire up to a hidden `<audio>` element so we get full-duplex audio once the connection hits `connected`.
5. **Status lifecycle**: failures leave the UI in the `error` state instead of resetting to `idle`, making it obvious when SDP or media setup needs attention.

## Deployment (permanent, secure URL)

1. **Initialize git (optional but recommended)**
   ```bash
   git init
   git add .
   git commit -m "voice bridge"
   ```
2. **Create a Vercel project**
   - `npm i -g vercel` (if not already installed)
   - `vercel login`
   - `vercel` (first deploy) – select this folder, accept build defaults.
3. **Set environment variables in Vercel**
   - `OPENAI_API_KEY`
   - `OPENAI_REALTIME_MODEL` (optional)
   - `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`
4. **Deploy**
   - `vercel --prod`
   - Result: `https://your-project.vercel.app` (TLS by default).

For extra security you can later attach a custom domain (`voice.yourdomain.com`), wrap the app with Vercel password protection, or put it behind Cloudflare Zero Trust/Tailscale. The middleware-based BASIC auth already prevents random access.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [OpenAI Realtime reference](https://platform.openai.com/docs/guides/realtime)

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start local dev server |
| `npm run build` | Production build |
| `npm run start` | Serve build |
| `npm run lint` | Lint project |
