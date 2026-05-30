const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const collections = require("../config/collections");
const JWT_SECRET = process.env.JWT_SECRET_KEY || "ISP_BILLING_SECRET_KEY";

// VERIFY TOKEN
exports.protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = String(decoded.id || decoded._id || "").trim();
    const sessionId = String(decoded.sessionId || "").trim();

    if (userId && sessionId) {
      const user = await mongoose.connection.db
        .collection(collections.credentials)
        .findOne(
          { ID: userId },
          { projection: { ActiveSessionId: 1 } }
        );
      const activeSessionId = String(user?.ActiveSessionId || "").trim();

      if (activeSessionId && activeSessionId !== sessionId) {
        return res.status(401).json({
          error: "Your account was logged in from another device.",
          code: "SESSION_REPLACED"
        });
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ROLE CHECK
exports.authorize = (...roles) => {
  return (req, res, next) => {
    const userRole = String(req.user.type || req.user.role || "").toUpperCase();
    const allowedRoles = roles.map((role) => String(role).toUpperCase());

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  };
};
