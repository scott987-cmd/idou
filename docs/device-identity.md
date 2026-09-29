# Durable desktop device identity

The desktop now retains its **own Ed25519 login-signing key**, encrypted using the same native OS-backed cipher policy as the local Wiki. It is not a MiniMax key, Feishu application secret, Feishu user token, password, browser cookie or bundled-CLI credential. None of those credentials is imported into this store.

## Why this fixes same-device re-login

Previously `FeishuLoginClient.begin` generated an ephemeral key on every attempt. The server derives `deviceId` from that public key, and the Wiki coordinator derives its node from the tenant/application, user and device. A fresh login therefore changed the node despite keeping the same account directory. The publisher correctly refused to treat the old node's journal entries as its own.

The desktop now supplies a durable key factory to the login client. The server still requires a fresh OAuth authorization, browser/PKCE checks and a signature over each unique flow/nonce/action. Reusing the device key does not reuse a bearer token or an authorization result. Logout/exit still revoke and remove short-lived session leases. An unchanged document can pass existing publisher deduplication after re-login, while a new revision acquires a fresh lease/key/scope/budget and produces the next version. Publisher ownership checks, journal records, manifests and coordinator schema are unchanged.

The client also compares the authenticated response's `deviceId` with its actual signing public key and rejects/revokes a substituted device result. Desktop confirmation checks that the server's current device ID still matches the redeemed session before creating the local session lease.

## Storage and lifecycle

- One encrypted record per normalized control-plane origin under the desktop's `device-identity/` directory. Different origins get different keys; the path includes only an origin hash. Accounts on the same installation/server share the physical-device identity, but account namespaces and coordinator nodes still include tenant/application/user.
- The new directory must be private/current-user owned on POSIX. Files are private, bounded, single-link regular files opened without following a final symlink. The decrypted record is versioned, exact-field validated, origin-bound, canonical Ed25519 PKCS#8. Exported byte buffers are cleared after use; JavaScript strings/KeyObjects are not claimed to be securely erased.
- Creation encrypts before writing, fsyncs a private temporary file and publishes it with a non-replacing link. A concurrent creator cannot overwrite an existing identity. The winner is read back after the temporary link is removed. In-process operations serialize; cross-process transient conflicts can fail closed rather than rotate a key. The app's existing single-instance lock remains relevant.
- No plaintext or ephemeral fallback when encryption, permissions, parsing or disk access fails. A corrupt existing record is left unchanged. Logout does not delete the identity; future login still requires OAuth. No key/private record is exposed through the renderer bridge, task runtime, CLI configuration, model request or a new server endpoint.
- The Electron entry uses OS encryption only when available; Linux requires an approved secure backend rather than `basic_text`. Test-only entries replace this cipher with deterministic AES fixtures so development verification does not operate the real Keychain.

## Limits

This is encrypted software key storage, **not hardware-bound or non-exportable attestation**. A compromised same-OS-user process may access app memory or decrypt storage. The same origin-bound key also signs optional [bounded online renewal](feishu-login.md#optional-bounded-online-renewal); no OAuth credential is imported into it. Session use remains short-lived bearer authentication after signing; per-request proof, administrator device enrollment/revocation, key rotation/recovery and persistent renewable sessions remain separate work.

Records created by older app versions used already-lost ephemeral keys. This change cannot reconstruct those private keys or automatically adopt their remote heads. They remain paused for explicit safe reconciliation. Deleting the identity file, changing the control-plane origin, reinstalling without preserving data, or using another device creates a different node and does not transfer old ownership. Cross-device merging/automatic receive is still unfinished.

## Verification

Unit tests exercise stable signing after a new store instance, server isolation, encrypted/private storage, concurrent creation, disabled cipher, corrupt/wrong-origin/wrong-key records, extra fields, unsafe mode, hard links, symlinks and size bounds without silent regeneration. HTTP login tests use separate client/store instances, prove that device identity is stable while bearer sessions change, and verify old session revocation, cancellation during key loading and substituted-device rejection. Desktop-auth tests reject device substitution at confirmation.

The extended publication desktop smoke uses a real Electron process restart and another full synthetic OAuth flow, then checks unchanged/no-reupload behavior and the next published generation. Its Feishu/CLI/cipher boundaries remain synthetic; no real account login, business write, OS Keychain repair or paid model call is part of this test.
