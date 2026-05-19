const mongoose = require("mongoose");
const collections = require("../config/collections");

const DEFAULT_COMPANY_NAME = "DNS NETWORK";
const DEFAULT_DISCONNECT_AFTER_DAYS = Number(process.env.DISCONNECT_AFTER_DAYS || 15);

const defaultSystemSettings = () => ({
  CompanyName: DEFAULT_COMPANY_NAME,
  CompanyAddress: "",
  CompanyContactNumber: "",
  CompanyEmailAddress: "",
  CompanyWebsite: "",
  CompanyTin: "",
  DisconnectAfterDueDays:
    Number.isFinite(DEFAULT_DISCONNECT_AFTER_DAYS) && DEFAULT_DISCONNECT_AFTER_DAYS >= 0
      ? DEFAULT_DISCONNECT_AFTER_DAYS
      : 15,
  updatedAt: null
});

const normalizeDays = (value, fallback) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.floor(numericValue);
};

const sanitizeSystemSettings = (settings = {}) => {
  const defaults = defaultSystemSettings();

  return {
    ...defaults,
    ...settings,
    CompanyName: String(settings.CompanyName ?? defaults.CompanyName).trim() || defaults.CompanyName,
    CompanyAddress: String(settings.CompanyAddress ?? defaults.CompanyAddress).trim(),
    CompanyContactNumber: String(
      settings.CompanyContactNumber ?? defaults.CompanyContactNumber
    ).trim(),
    CompanyEmailAddress: String(
      settings.CompanyEmailAddress ?? defaults.CompanyEmailAddress
    ).trim(),
    CompanyWebsite: String(settings.CompanyWebsite ?? defaults.CompanyWebsite).trim(),
    CompanyTin: String(settings.CompanyTin ?? defaults.CompanyTin).trim(),
    DisconnectAfterDueDays: normalizeDays(
      settings.DisconnectAfterDueDays ?? defaults.DisconnectAfterDueDays,
      defaults.DisconnectAfterDueDays
    )
  };
};

const getSystemSettingsCollection = () =>
  mongoose.connection.db.collection(collections.systemSettings);

const getSystemSettings = async () => {
  const current = await getSystemSettingsCollection().findOne({});
  return sanitizeSystemSettings(current || {});
};

const saveSystemSettings = async (settings = {}) => {
  const collection = getSystemSettingsCollection();
  const current = await collection.findOne({});
  const nextSettings = sanitizeSystemSettings({
    ...(current || {}),
    ...settings,
    updatedAt: new Date()
  });
  const { _id, ...payload } = nextSettings;

  if (current?._id) {
    await collection.updateOne({ _id: current._id }, { $set: payload });
  } else {
    await collection.insertOne({
      ...payload,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  return {
    ...(current?._id ? { _id: current._id } : {}),
    ...payload
  };
};

const getDisconnectAfterDueDays = async () => {
  const settings = await getSystemSettings();
  return normalizeDays(
    settings.DisconnectAfterDueDays,
    defaultSystemSettings().DisconnectAfterDueDays
  );
};

const getCompanyName = async () => {
  const settings = await getSystemSettings();
  return String(settings.CompanyName || DEFAULT_COMPANY_NAME).trim() || DEFAULT_COMPANY_NAME;
};

module.exports = {
  DEFAULT_COMPANY_NAME,
  defaultSystemSettings,
  getCompanyName,
  getDisconnectAfterDueDays,
  getSystemSettings,
  saveSystemSettings,
  sanitizeSystemSettings
};
