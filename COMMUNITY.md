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

### Provider registration and release requirements

Use `Workfolio` as the public app name and `https://workfolio.life` as the homepage. Select only the basic provider user identifier: the current implementation does not need email, real name, phone number, profile photo, contacts, or birthday. Google requests `openid`; Apple does not request `name` or `email`.

- **Kakao:** register a web app, enable Kakao Login, register the exact callback above, and use the REST API key and its enabled client secret. See [Kakao configuration](https://developers.kakao.com/docs/ko/kakaologin/prerequisite).
- **Naver:** register Naver Login for the website with the exact callback above. App administrators and registered testers can test first. General public access requires approval of Naver's prior review; prepare screenshots of the actual button, consent, and completed sign-in flow. See [app registration](https://developers.naver.com/docs/common/openapiguide/appregister.md) and [prior review](https://developers.naver.com/docs/login/verify/verify.md).
- **Google:** configure Google Auth Platform branding, audience, and an OAuth client of type Web application. Use only `openid` for this implementation. Configure the exact callback and check the production publishing/verification status in the console before treating sign-in as publicly available.
- **Apple:** requires Apple Developer Program access, a Sign in with Apple-enabled primary App ID, a web Services ID, the domain `workfolio.life`, the exact HTTPS return URL above, and a signing key (or valid pre-generated client secret). Apple's [environment setup documentation](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple) also requires an existing App Store app using Sign in with Apple for web authentication. Creating a placeholder App ID alone does not establish eligibility. Confirm a related eligible app and developer membership before proceeding with [web configuration](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/).

Account sign-in, identity checks, provider agreements, paid memberships, app review, and production publishing are external steps. They are not completed by deploying this repository. Review the website's privacy and terms content against the community's actual data handling before submitting the app for public release.
