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
npx wrangler d1 execute DB --local --file migrations/0007_community_kakao_events.sql
npm run preview:community
```

Local Pages preview is `http://localhost:8788`. Do not test real Apple authorization on localhost; Apple requires a registered HTTPS domain. `.dev.vars` is ignored and `.dev.vars.example` documents key names only.

## Production deployment

Push `main` to the existing `dirndhkd97/workfolio` GitHub repository. `.github/workflows/deploy.yml` runs checks, builds Astro, applies the additive community SQL files `0005` through `0007`, then deploys Cloudflare Pages. The existing `CLOUDFLARE_API_TOKEN` GitHub secret needs Pages deployment and D1 write permission for the existing account. Legacy SQL files are not replayed. Do not modify migrations after they have been applied; future schema changes need new files and matching workflow updates.

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

Callback failures emit a `community_oauth_failure` console warning containing only `provider`, a fixed `stage`, `http_status`, and an allowlisted `provider_code`. Use it to distinguish state storage, token requests/responses, token validation, user-info requests/responses, and session storage. Unknown provider errors are represented as `null`; exception messages, response bodies, authorization codes, tokens, secrets and member numbers are never logged. When inspecting Cloudflare tail output, extract only these console fields: raw platform request events may independently contain callback URLs with authorization codes and must not be printed or saved as diagnostic output.

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

### Kakao unlink events

After migration `0007` and the endpoint are deployed, open Kakao Developers **App → Webhooks → Account Status Change Webhook**, register `https://workfolio.life/api/community-auth/kakao/events`, enable it, and subscribe only to **OAUTH → User Unlinked**. Do not register this URL as the older Admin-key unlink webhook. No new secret or `openid_sse` consent scope is needed; `KAKAO_CLIENT_ID` must be the app's primary REST API key. Use Kakao's webhook test tool to verify a signed event receives an empty `202` response. See the official [event specification](https://developers.kakao.com/docs/ko/kakaologin/callback) and [console settings](https://developers.kakao.com/docs/ko/app-setting/app).

The receiver checks Kakao's RS256 signature against cached official public keys, exact issuer/audience/type, the supported event and matching subject, timestamps, and replay receipts. Its four-hour event acceptance window covers Kakao's documented retry schedule; future clock skew is limited to 60 seconds. Invalid tokens receive `400`; temporary key-fetch/storage failures receive `503` for retry. Unknown users and already-processed deliveries receive `202` without side effects.

An accepted unlink atomically deletes the matching Kakao provider link (including the provider member number) and all that identity's sessions. Existing internal user IDs, random nicknames, posts, comments, reactions and reports remain; content deletion policy is a separate decision. A later new sign-in creates a new identity. A delayed first delivery revokes the currently linked identity conservatively: local account creation time cannot prove whether provider consent was renewed. Previously processed event retries have no effect on a later login. Same-second ordering is also conservative because Kakao event time has whole-second precision; an immediate sign-in may need a retry.

No raw SET or raw member number is stored in event receipts or logged. A SHA-256 member-number hash and event timestamp block OAuth flows already in progress for 11 minutes. The event-ID hash prevents repeated processing for 24 hours, exceeding the accepted token lifetime. Expired subject hashes are cleared and expired receipts deleted on the next OAuth start or verified event delivery; these are opportunistic cleanup points, **not a scheduled hard deletion deadline**. Without further traffic, expired rows remain until the next cleanup. Account creation and session issuance check the watermark in the same D1 transaction, preventing an in-flight callback from restoring a disconnected account.
