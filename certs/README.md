# QZ Tray certificate files

Put the QZ Tray signing files in this folder:

- `qz-public-cert.pem` - public certificate used by the browser.
- `qz-private-key.pem` - private key used by the backend to sign QZ requests.

Keep the private key secret. It is ignored by git.

You can also override the paths with:

- `QZ_CERT_PATH`
- `QZ_PRIVATE_KEY_PATH`
