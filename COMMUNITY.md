# Workfolio community

The existing Astro project serves the community at `https://workfolio.life/` through its existing Cloudflare Pages project `workfolio`. The earlier Sites implementation is a separate deployment and is not used by this repository. The previous agency homepage remains at `/studio`; existing billing and customer routes remain in place.

## Access and data

Anonymous visitors can read posts and comments and search the current feed. Creating posts, comments, reactions, reports, and deleting one's own post require a verified community session. Community identities use separate tables and a hashed, HttpOnly session cookie. Legacy customer sessions and client-supplied identity headers do not grant community access. Provider email addresses are not stored or used to link accounts. Signing in with a different provider creates a separate account.

The feed fetches the latest 60 real posts and six labelled fictional examples. Trending excludes examples and uses real reactions/comments on posts from the past seven days. No fake engagement is added.

## Build and verification

```sh
npm ci
npm run check:community
npm run test:community
npm run build
npx wrangler d1 execute DB --local --file migrations/0005_community_auth.sql
npx wrangler d1 execute DB --local --file migrations/0006_community_board.sql
npm run preview:community
```

Local Pages preview is `http://localhost:8788`. Do not test real Apple authorization on localhost; Apple requires a registered HTTPS domain. `.dev.vars` is ignored and `.dev.vars.example` documents key names only.

## Production deployment

Push `main` to the existing `dirndhkd97/workfolio` GitHub repository. `.github/workflows/deploy.yml` runs checks, builds Astro, applies only the two additive community SQL files, then deploys Cloudflare Pages. The existing `CLOUDFLARE_API_TOKEN` GitHub secret needs Pages deployment and D1 write permission for the existing account. Legacy SQL files are not replayed. Do not modify migrations after they have been applied; future schema changes need new files and matching workflow updates.

## Activate social login

The four real authorization-code flows are implemented, but provider apps must first be registered by the owner and approved where required. Missing credentials keep the provider disabled. Setting keys alone is not evidence of a successful end-to-end login: verify an actual sign-in, return, session, logout, and a permitted write for each provider after app configuration.

Register `https://workfolio.life` as the website origin. Register these exact callbacks:

| Provider | Callback URL | Cloudflare Pages production secrets |
|---|---|---|
| Kakao | `https://workfolio.life/api/community-auth/kakao/callback` | `KAKAO_CLIENT_ID` (REST API key), `KAKAO_CLIENT_SECRET` |
| Naver | `https://workfolio.life/api/community-auth/naver/callback` | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` |
| Google | `https://workfolio.life/api/community-auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Apple | `https://workfolio.life/api/community-auth/apple/callback` | `APPLE_CLIENT_ID` (Services ID), plus either `APPLE_CLIENT_SECRET` or `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |

Store all values in Cloudflare Pages **workfolio → Settings → Variables and Secrets → Production**, then redeploy. Never put secrets in Git, browser code, public environment variables, or chat. Apple signing-key mode generates short-lived ES256 client secrets; a supplied Apple client-secret JWT must be rotated before it expires.

The readiness endpoint `/api/community-auth/me` exposes only provider IDs, labels, readiness booleans, and the current user's safe display identity. It never returns keys. OAuth state is browser-bound, short-lived and single-use. Google/Kakao use PKCE; Google/Apple ID tokens are signature/issuer/audience/nonce verified. Apple uses its required POST callback and Secure SameSite=None transaction cookie. Logout and board mutations enforce same-origin requests.

Official provider setup references:

- Kakao: https://developers.kakao.com/docs/ko/kakaologin/rest-api
- Naver: https://developers.naver.com/docs/login/devguide
- Google: https://developers.google.com/identity/openid-connect/openid-connect
- Apple: https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms

Apple requires a developer account, a Sign in with Apple-enabled primary App ID, a web Services ID, a registered HTTPS domain/return URL, and a signing key (or valid pre-generated client secret). The local implementation does not create these external developer resources or accept provider agreements for the owner.
