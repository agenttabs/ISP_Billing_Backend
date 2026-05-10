const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const JWT_SECRET = process.env.JWT_SECRET_KEY || "ISP_BILLING_SECRET_KEY";

const normalizeUserType = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "EMPLOYEE" ? "TECHNICIAN" : normalized;
};

const sanitizeCredentialUser = (user) => ({
  ID: user.ID,
  Name: user.Name,
  Username: user.Username,
  Type: normalizeUserType(user.Type),
  Status: String(user.Status || "ACTIVE").trim().toUpperCase() || "ACTIVE",
  Restriction: user.Restriction || "",
  Contact: user.Contact || "",
  Email: user.Email || "",
  FB: user.FB || "",
  Salary: user.Salary || "",
  TelegramChatID: user.TelegramChatID || "",
  TelegramToken: user.TelegramToken || ""
});

const getCredentialCollection = () =>
  mongoose.connection.db.collection(collections.credentials);

const loadCredentials = async () => {
  return getCredentialCollection().find({}).toArray();
};

exports.signup = async (_req, res) => {
  return res.status(405).json({
    error: "Signup is disabled. Please use the credential collection."
  });
};

exports.login = async (req, res) => {
  try {
    const normalizedUsername = String(req.body.username || "")
      .trim()
      .toLowerCase();
    const normalizedPassword = String(req.body.password || "");
    const credentials = await loadCredentials();
    const user = credentials.find(
      (item) =>
        String(item.Username || "").trim().toLowerCase() === normalizedUsername
    );

    if (!user) {
      await writeAuditLog({
        req,
        module: "AUTH",
        action: "LOGIN",
        targetType: "USER",
        status: "FAILED",
        summary: "Login failed: user not found.",
        details: {
          username: normalizedUsername
        }
      });
      return res.status(401).json({ error: "User not found" });
    }

    if (String(user.Password || "") !== normalizedPassword) {
      await writeAuditLog({
        req,
        module: "AUTH",
        action: "LOGIN",
        targetType: "USER",
        targetId: user.ID,
        status: "FAILED",
        summary: "Login failed: invalid password.",
        accountName: user.Username,
        details: {
          username: user.Username,
          name: user.Name
        }
      });
      return res.status(401).json({ error: "Invalid password" });
    }

    const userStatus = String(user.Status || "ACTIVE").trim().toUpperCase();
    if (userStatus === "DEACTIVE" || userStatus === "INACTIVE") {
      await writeAuditLog({
        req,
        module: "AUTH",
        action: "LOGIN",
        targetType: "USER",
        targetId: user.ID,
        status: "FAILED",
        summary: "Login failed: account is deactivated.",
        accountName: user.Username,
        details: {
          username: user.Username,
          name: user.Name,
          status: userStatus
        }
      });
      return res.status(401).json({ error: "Account is deactivated" });
    }

    const userPayload = {
      _id: user.ID,
      id: user.ID,
      name: user.Name,
      username: user.Username,
      type: normalizeUserType(user.Type),
      status: userStatus,
      restriction: user.Restriction || "",
      email: user.Email || "",
      contact: user.Contact || ""
    };

    const token = jwt.sign(userPayload, JWT_SECRET, { expiresIn: "1d" });

    await writeAuditLog({
      req,
      actor: {
        userId: userPayload.id,
        name: userPayload.name,
        username: userPayload.username,
        type: userPayload.type,
        loginAccount: userPayload.username
      },
      module: "AUTH",
      action: "LOGIN",
      targetType: "USER",
      targetId: userPayload.id,
      accountName: userPayload.username,
      status: "SUCCESS",
      summary: "User logged in.",
      details: {
        restriction: userPayload.restriction,
        email: userPayload.email,
        contact: userPayload.contact
      }
    });

    return res.json({
      token,
      user: userPayload
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.me = async (req, res) => {
  return res.json({ user: req.user });
};

exports.changeMyPassword = async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || "").trim();
    const usernameFromToken = String(req.user?.username || "").trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Current password and new password are required."
      });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({
        error: "New password must be at least 4 characters."
      });
    }

    const collection = getCredentialCollection();
    const credentials = await loadCredentials();
    const existingUser = credentials.find((item) => {
      const itemId = String(item.ID || "").trim();
      const itemUsername = String(item.Username || "").trim().toLowerCase();
      return (userId && itemId === userId) || (usernameFromToken && itemUsername === usernameFromToken);
    });

    if (!existingUser) {
      return res.status(404).json({ error: "User not found." });
    }

    if (String(existingUser.Password || "") !== currentPassword) {
      await writeAuditLog({
        req,
        actor: {
          userId: existingUser.ID,
          name: existingUser.Name,
          username: existingUser.Username,
          type: normalizeUserType(existingUser.Type),
          loginAccount: existingUser.Username
        },
        module: "AUTH",
        action: "CHANGE_PASSWORD",
        targetType: "USER",
        targetId: existingUser.ID,
        accountName: existingUser.Username,
        status: "FAILED",
        summary: "Change password failed: invalid current password."
      });

      return res.status(400).json({ error: "Current password is incorrect." });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        error: "New password must be different from the current password."
      });
    }

    await collection.updateOne(
      { ID: String(existingUser.ID || "") },
      {
        $set: {
          Password: newPassword,
          updatedAt: new Date()
        }
      }
    );

    await writeAuditLog({
      req,
      actor: {
        userId: existingUser.ID,
        name: existingUser.Name,
        username: existingUser.Username,
        type: normalizeUserType(existingUser.Type),
        loginAccount: existingUser.Username
      },
      module: "AUTH",
      action: "CHANGE_PASSWORD",
      targetType: "USER",
      targetId: existingUser.ID,
      accountName: existingUser.Username,
      status: "SUCCESS",
      summary: "User changed their password."
    });

    return res.json({ message: "Password changed successfully." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getUsers = async (_req, res) => {
  try {
    const credentials = (await loadCredentials()).map(sanitizeCredentialUser);
    return res.json(credentials);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getTechnicians = async (_req, res) => {
  try {
    const technicians = (await loadCredentials())
      .map(sanitizeCredentialUser)
      .filter((user) => normalizeUserType(user.Type) === "TECHNICIAN");

    return res.json(technicians);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const credentials = await loadCredentials();
    const collection = getCredentialCollection();
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "").trim();
    const name = String(req.body.name || "").trim();
    const type = normalizeUserType(req.body.type);
    const requestedStatus = String(req.body.status || "ACTIVE").trim().toUpperCase();
    const status = type === "ADMIN" ? "ACTIVE" : requestedStatus || "ACTIVE";

    if (!username || !password || !name || !type) {
      return res.status(400).json({
        error: "Name, username, password, and type are required."
      });
    }

    const exists = credentials.some(
      (item) =>
        String(item.Username || "").trim().toLowerCase() === username.toLowerCase()
    );

    if (exists) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const nextId =
      credentials.reduce((max, item) => {
        const current = Number(item.ID || 0);
        return Number.isFinite(current) ? Math.max(max, current) : max;
      }, 1000) + 1;

    const newUser = {
      Contact: String(req.body.contact || "").trim(),
      Email: String(req.body.email || "").trim(),
      FB: "",
      ID: String(nextId),
      Name: name,
      Password: password,
      Restriction: String(req.body.restriction || "Default").trim(),
      Salary: String(req.body.salary || "").trim(),
      Status: status === "DEACTIVE" ? "DEACTIVE" : "ACTIVE",
      TelegramChatID: "",
      TelegramToken: "",
      Type: type,
      Username: username,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await collection.insertOne(newUser);

    await writeAuditLog({
      req,
      module: "USER",
      action: "CREATE",
      targetType: "USER",
      targetId: newUser.ID,
      accountName: newUser.Username,
      status: "SUCCESS",
      summary: "New user created.",
      values: sanitizeCredentialUser(newUser)
    });

    return res.status(201).json({
      user: sanitizeCredentialUser(newUser)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    const credentials = await loadCredentials();
    const collection = getCredentialCollection();
    const existingUser = credentials.find(
      (item) => String(item.ID || "").trim() === userId
    );

    if (!existingUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const username = String(req.body.username || existingUser.Username || "").trim();
    const name = String(req.body.name || existingUser.Name || "").trim();
    const type = normalizeUserType(req.body.type || existingUser.Type);
    const requestedStatus = String(
      req.body.status ?? existingUser.Status ?? "ACTIVE"
    )
      .trim()
      .toUpperCase();
    const status = type === "ADMIN" ? "ACTIVE" : requestedStatus || "ACTIVE";

    if (!username || !name || !type) {
      return res.status(400).json({
        error: "Name, username, and type are required."
      });
    }

    const usernameTaken = credentials.some(
      (item) =>
        String(item.ID || "").trim() !== userId &&
        String(item.Username || "").trim().toLowerCase() === username.toLowerCase()
    );

    if (usernameTaken) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const nextUser = {
      ...existingUser,
      Contact: String(req.body.contact ?? existingUser.Contact ?? "").trim(),
      Email: String(req.body.email ?? existingUser.Email ?? "").trim(),
      Name: name,
      Restriction: String(
        req.body.restriction ?? existingUser.Restriction ?? "Default"
      ).trim(),
      Salary: String(req.body.salary ?? existingUser.Salary ?? "").trim(),
      Status: status === "DEACTIVE" ? "DEACTIVE" : "ACTIVE",
      Type: type,
      Username: username,
      updatedAt: new Date()
    };

    const password = String(req.body.password || "").trim();
    if (password) {
      nextUser.Password = password;
    }

    await collection.updateOne(
      { ID: userId },
      {
        $set: nextUser
      }
    );

    await writeAuditLog({
      req,
      module: "USER",
      action: "UPDATE",
      targetType: "USER",
      targetId: nextUser.ID,
      accountName: nextUser.Username,
      status: "SUCCESS",
      summary: "User updated.",
      details: {
        previous: sanitizeCredentialUser(existingUser)
      },
      values: sanitizeCredentialUser(nextUser)
    });

    return res.json({
      user: sanitizeCredentialUser(nextUser)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
