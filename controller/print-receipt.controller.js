const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const defaultPrintReceiptConfig = () => ({
  Name: "Default Thermal Receipt",
  CompanyName: "DNS NETWORKS",
  ReceiptTitle: "Official Payment Receipt",
  ReceiptSubtitle: "For Xprinter / Thermal Printer",
  FooterNote: "Thank you for your payment.",
  PreferredPrinterName: "Xprinter",
  EnablePrinting: true,
  UseDirectPrint: true,
  ShowSubscriptionCover: true,
  ShowContactNumber: true,
  ShowReference: true,
  ShowCreatedBy: true,
  updatedAt: null
});

const sanitizeConfig = (config = {}) => {
  const defaults = defaultPrintReceiptConfig();

  return {
    ...defaults,
    ...config,
    Name: String(config.Name ?? defaults.Name).trim(),
    CompanyName: String(config.CompanyName ?? defaults.CompanyName).trim(),
    ReceiptTitle: String(config.ReceiptTitle ?? defaults.ReceiptTitle).trim(),
    ReceiptSubtitle: String(config.ReceiptSubtitle ?? defaults.ReceiptSubtitle).trim(),
    FooterNote: String(config.FooterNote ?? defaults.FooterNote).trim(),
    PreferredPrinterName: String(
      config.PreferredPrinterName ?? defaults.PreferredPrinterName
    ).trim(),
    EnablePrinting: Boolean(
      config.EnablePrinting ?? defaults.EnablePrinting
    ),
    UseDirectPrint: Boolean(
      config.UseDirectPrint ?? defaults.UseDirectPrint
    ),
    ShowSubscriptionCover: Boolean(
      config.ShowSubscriptionCover ?? defaults.ShowSubscriptionCover
    ),
    ShowContactNumber: Boolean(
      config.ShowContactNumber ?? defaults.ShowContactNumber
    ),
    ShowReference: Boolean(
      config.ShowReference ?? defaults.ShowReference
    ),
    ShowCreatedBy: Boolean(
      config.ShowCreatedBy ?? defaults.ShowCreatedBy
    )
  };
};

const getReceiptCollection = () =>
  mongoose.connection.db.collection(collections.printReceipt);

exports.getPrintReceiptConfig = async (_req, res) => {
  try {
    const current = await getReceiptCollection().findOne({});
    res.json(sanitizeConfig(current || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.savePrintReceiptConfig = async (req, res) => {
  try {
    const collection = getReceiptCollection();
    const current = await collection.findOne({});
    const mergedConfig = sanitizeConfig({
      ...(current || {}),
      ...req.body,
      updatedAt: new Date()
    });
    const { _id, ...nextConfig } = mergedConfig;

    if (current?._id) {
      await collection.updateOne(
        { _id: current._id },
        {
          $set: nextConfig
        }
      );
    } else {
      await collection.insertOne({
        ...nextConfig,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    res.json({
      ...(current?._id ? { _id: current._id } : {}),
      ...nextConfig
    });

    await writeAuditLog({
      req,
      module: "PRINT_RECEIPT",
      action: "SAVE_CONFIG",
      targetType: "PRINT_RECEIPT",
      status: "SUCCESS",
      summary: "Print receipt configuration saved.",
      values: nextConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.defaultPrintReceiptConfig = defaultPrintReceiptConfig;
