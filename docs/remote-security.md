# Remote browser security

Device login and desktop pairing have separate jobs. The existing DTC
Google/Cognito device flow authorizes connections to the gateway. Each
controller also generates a local P-256 key and self-signed certificate. The
desktop independently pins that certificate with a local permission grant;
the controller independently pins the desktop certificate. Transfer only the
public certificates over a separately trusted operator channel, comparing their
SHA-256 fingerprints. Never obtain initial pins from the relay itself.

Browser HTTP requests, responses and file streams travel inside standard
mutually authenticated TLS 1.3 over the WebSocket relay. The relay cannot read
or forge that inner stream. It can observe device/owner identifiers, timing and
volume, disconnect clients or deny service. Public HTTPS still authenticates
the gateway. There are no plaintext command or transfer routes and no
compatibility fallback to the previous transport.

## Initial pairing

On the desktop:

```sh
node bin/cli.js auth identity --daemon --output desktop-public.pem
node bin/cli.js auth login --daemon --device desktop
```

On the controller:

```sh
node bin/cli.js auth identity --output controller-public.pem
node bin/cli.js auth login --device desktop
```

Transfer the two PUBLIC PEM files through the trusted operator channel. Match
the fingerprints printed by the CLI and device-approval page. On the desktop:

```sh
node bin/cli.js daemon trust --certificate-file controller-public.pem --profiles orin --mode interact --origins '*'
node bin/cli.js daemon
```

On the controller:

```sh
node bin/cli.js auth pair --certificate-file desktop-public.pem
node bin/cli.js remote check desktop
node bin/cli.js --remote desktop --browser orin call access.info '{}'
```

Pairing defaults to Orin, inspection only, and a 30-day local grant. The
installed Orin grant explicitly enables general interaction and uploads using
`interact` and `*`. Main is not included. For a separate main grant, generate a
separate controller identity with `auth identity --identity-file PATH`, use the
same option with `auth login --credential-file OTHER_PATH --name desktop-main`,
and explicitly pair that public certificate locally with `--profiles main`.
Do not expand the default Orin grant as an implicit fallback.

`inspect` allows snapshots, screenshots, tab listing and download inspection.
`interact` additionally allows clicks, typing, navigation and staged uploads;
`--origins` can list exact allowed origins instead of `*`. `script` additionally
allows arbitrary page evaluation and needs an explicit local grant. Raw CDP,
recording, teaching, browser renaming and extension reload are never exposed
remotely. File and browser-internal URLs/tabs are denied. Local CLI behavior
is unchanged and trusts local processes on the desktop.

Uploads must first be streamed into managed staging storage. Supplying a
known arbitrary desktop path to `page.upload` is rejected. Limits are 64 MiB
per file, 512 MiB total and 128 files, with 24-hour retention and periodic
cleanup. Download retrieval accepts only Chrome download IDs in an allowed
profile. It does not accept arbitrary desktop file paths.

## Lifetime and revocation

Controller access tokens last 15 minutes. Renewal uses a non-rotating 30-day
grant plus a fresh ES256 device-key proof covering the endpoint and grant.
Proof IDs are persisted briefly to reject replay. A stolen renewal token alone
cannot renew access. Device login must be repeated after the grant expires.
Daemon publication credentials last 30 days. Locally generated certificates
last one year; replace and independently re-pair before expiry.

`auth logout` or portal revocation removes the renewal grant and all derived
access tokens. Gateway revocation closes active tunnels. Independently,
`daemon untrust --fingerprint SHA256` removes local permission and closes
active inner TLS connections within two seconds, even if the gateway is
compromised. Each request rechecks the local grant. Pause in the extension
stops commands for that profile.

The relay caps connections, tunnels, bytes, frame sizes, buffering and tunnel
lifetime. Audits contain operation names, outcomes, hashed owners, certificate
fingerprints and byte counts; never page URLs, contents, selectors, bodies,
tokens or cookies. Production logs must be bounded and rotated.

The browser's private home, authentication directory and upload staging
directories use owner-only permissions, including explicit Windows ACLs;
POSIX mode flags alone do not restrict Windows access. Individual credentials
and identities are written atomically into private files. These are browser
service permissions, not changes to unrelated agents' OS accounts.

## Remaining trust

General Orin interaction can read sensitive pages and submit real account
actions. Prompt injection, a compromised controller process or stolen local
private keys can abuse the permissions granted to that controller. This is not
an OS sandbox: local agents and the desktop account remain trusted, and web
navigation can reach sites available from the desktop. Protect those machines,
keep their software updated and grant narrower origins when the task permits.
A relay compromise alone cannot grant a new browser identity or decrypt
browser data. Broader OS account separation and Workspace MFA policy are
separate changes.

## Upgrade

Protocol 2 is a coordinated gateway/daemon/controller upgrade. Legacy
controller credentials require one fresh device-key login and public-certificate
pairing. Existing daemon publication credentials can be retained. Preserve
private state separately from source releases. Roll back source only with an
explicit security decision: the old transport grants broader plaintext access.
Do not silently fall back or copy private keys between machines.
