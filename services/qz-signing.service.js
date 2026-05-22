const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const certificatePath =
  process.env.QZ_CERT_PATH ||
  path.join(__dirname, "..", "certs", "qz-public-cert.pem");
const privateKeyPath =
  process.env.QZ_PRIVATE_KEY_PATH ||
  path.join(__dirname, "..", "certs", "qz-private-key.pem");

const readTextFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    const error = new Error(`${label} not found at ${filePath}`);
    error.statusCode = 503;
    throw error;
  }

  return fs.readFileSync(filePath, "utf8");
};

const getCertificate = () => readTextFile(certificatePath, "QZ public certificate");

const signRequest = (request) => {
  const privateKey = readTextFile(privateKeyPath, "QZ private key");
  const signer = crypto.createSign("RSA-SHA512");

  signer.update(String(request || ""), "utf8");
  signer.end();

  return signer.sign(privateKey, "base64");
};

module.exports = {
  getCertificate,
  signRequest,
};
