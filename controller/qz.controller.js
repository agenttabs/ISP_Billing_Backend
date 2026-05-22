const qzSigningService = require("../services/qz-signing.service");

exports.getCertificate = (req, res, next) => {
  try {
    res.type("text/plain").send(qzSigningService.getCertificate());
  } catch (error) {
    next(error);
  }
};

exports.signRequest = (req, res, next) => {
  try {
    const request = req.body?.request || req.body?.data || req.body?.message || "";

    if (!request) {
      return res.status(400).json({ error: "Missing QZ signing request." });
    }

    return res.json({ signature: qzSigningService.signRequest(request) });
  } catch (error) {
    return next(error);
  }
};
