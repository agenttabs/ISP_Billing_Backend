const mongoose = require("mongoose");
const collections = require("../config/collections");
const { getPppActiveRows } = require("../services/mikrotik");
const {
  normalizeMac,
  normalizeSn,
  runLiveOltLookup
} = require("../services/olt-telnet.service");

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getMacMatchKey = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  return hex.length === 12 ? hex.slice(0, -2) : "";
};

const getActiveMac = (active = {}) =>
  normalizeMac(
    active["caller-id"] ||
      active.callerId ||
      active["mac-address"] ||
      active.macAddress ||
      ""
  );

const getActiveIpAddress = (active = {}) =>
  String(active.address || active["remote-address"] || active.remoteAddress || "").trim();

const getClientActiveStatus = (client = null) => {
  if (!client) return false;

  const statusText = [
    client.Status,
    client.status,
    client.Profile,
    client.profile,
    client.NetPlan,
    client.netPlan,
    client.Plan,
    client.plan
  ]
    .map((value) => String(value || "").toUpperCase())
    .join(" ");

  return !(
    statusText.includes("DISCONNECTED") ||
    statusText.includes("DISCONNECTION") ||
    statusText.includes("DC-PUTOL")
  );
};

const toClientDto = (client) => {
  if (!client) {
    return {
      found: false,
      isActive: false
    };
  }

  return {
    found: true,
    isActive: getClientActiveStatus(client),
    clientName: client.ClientName || client.clientName || "",
    accountName: client.AccountName || client.accountName || "",
    accountNumber: client.AccountNumber || client.accountNumber || "",
    contactNumber: client.ContactNumber || client.contactNumber || "",
    dueDate: client.DueDate || client.dueDate || "",
    amountDue: client.AmountDue ?? client.amountDue ?? "",
    paymentStatus: client.PaymentStatus || client.paymentStatus || "",
    status: client.Status || client.status || "",
    netPlan: client.NetPlan || client.netPlan || client.Plan || client.plan || "",
    authenticationMode: client.AuthenticationMode || client.authenticationMode || "",
    macAddress: client.MacAddress || client.macAddress || ""
  };
};

const findClient = async ({ accountName, macAddress }) => {
  const filters = [];
  const account = String(accountName || "").trim();
  const mac = normalizeMac(macAddress);

  if (account) {
    const exactAccount = new RegExp(`^${escapeRegex(account)}$`, "i");
    filters.push({ AccountName: exactAccount }, { accountName: exactAccount });
  }

  if (mac) {
    const exactMac = new RegExp(`^${escapeRegex(mac)}$`, "i");
    filters.push({ MacAddress: exactMac }, { macAddress: exactMac });
  }

  if (filters.length === 0) return null;

  return mongoose.connection.db.collection(collections.clients).findOne({ $or: filters });
};

exports.lookupOltClient = async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "SN or MAC is required." });
    }

    const technology = String(req.query.technology || req.query.mode || "gpon")
      .trim()
      .toLowerCase();
    if (!["gpon", "epon"].includes(technology)) {
      return res.status(400).json({ error: "Technology must be GPON or EPON." });
    }

    const queryMac = normalizeMac(query);
    const querySn = normalizeSn(query);
    if (technology === "gpon" && queryMac) {
      return res.status(400).json({ error: "For GPON lookup, please enter the ONU SN/AuthInfo." });
    }
    if (technology === "epon" && !queryMac) {
      return res.status(400).json({ error: "For EPON lookup, please enter the OLT MAC address." });
    }

    const liveOlt = await runLiveOltLookup({
      macAddress: technology === "epon" ? queryMac : "",
      authInfo: technology === "gpon" ? querySn : "",
      technology
    });

    const oltMac = liveOlt.macMatch?.macAddress || "";
    const lookupMac = oltMac || queryMac;
    let pppActive = null;
    let pppActiveError = "";

    try {
      const activeRows = await getPppActiveRows();
      const lookupMacKey = getMacMatchKey(lookupMac);
      pppActive =
        activeRows.find((active) => {
          const activeMac = getActiveMac(active);
          return (
            activeMac &&
            lookupMac &&
            (activeMac === lookupMac || getMacMatchKey(activeMac) === lookupMacKey)
          );
        }) || null;
    } catch (err) {
      pppActiveError = err.message;
    }

    const mikrotikName = String(pppActive?.name || "").trim();
    const client = await findClient({
      accountName: mikrotikName,
      macAddress: lookupMac
    });

    const olt = liveOlt.macMatch || liveOlt.onuMatch
      ? {
          macAddress: oltMac,
          vlan: liveOlt.macMatch?.vlan || "",
          type: liveOlt.macMatch?.type || "",
          oltPort: liveOlt.macMatch?.oltPort || liveOlt.onuMatch?.oltPort || "",
          authInfo: liveOlt.onuMatch?.authInfo || "",
          onuType: liveOlt.onuMatch?.onuType || "",
          onuState: liveOlt.onuMatch?.onuState || "",
          sourceCommand: liveOlt.onuMatch?.sourceCommand || "",
          matchStatus: "FOUND_LIVE_TELNET"
        }
      : null;

    return res.json({
      query,
      normalized: {
        macAddress: queryMac,
        authInfo: querySn
      },
      matched: Boolean(olt || pppActive || client),
      source: "LIVE_TELNET",
      technology: technology.toUpperCase(),
      olt,
      liveTelnet: {
        commandsRun: liveOlt.commandsRun || [],
        macRowsFound: liveOlt.macRowsFound || 0,
        onuRowsFound: liveOlt.onuRowsFound || 0
      },
      mikrotik: {
        pppActiveFound: Boolean(pppActive),
        name: mikrotikName,
        macAddress: pppActive ? getActiveMac(pppActive) : "",
        ipAddress: pppActive ? getActiveIpAddress(pppActive) : "",
        service: pppActive?.service || "",
        uptime: pppActive?.uptime || "",
        error: pppActiveError
      },
      appClient: toClientDto(client)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
