const mongoose = require("mongoose");
const { RouterOSClient } = require("routeros-client");
const { Channel, RosException } = require("node-routeros");
const collections = require("../config/collections");
const normalizeServerType = (value) => String(value || "").trim().toUpperCase();
const getRouterOsPort = (value) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8728;
};

if (!Channel.prototype.__ispBillingEmptyReplyPatch) {
    Channel.prototype.processPacket = function processPacket(packet) {
        const reply = packet.shift();
        const parsed = this.parsePacket(packet);

        if (reply === "!empty") {
            return;
        }

        if (reply === "!trap") {
            this.trapped = true;
            this.emit("trap", parsed);
            return;
        }

        if (packet.length > 0 && !this.streaming) {
            this.emit("data", parsed);
        }

        switch (reply) {
            case "!re":
                if (this.streaming) {
                    this.emit("stream", parsed);
                }
                break;
            case "!done":
                if (!this.trapped) {
                    this.emit("done", this.data);
                }
                this.close();
                break;
            default:
                throw new RosException("UNKNOWNREPLY", { reply });
        }
    };
    Channel.prototype.__ispBillingEmptyReplyPatch = true;
}

// 🔥 GET SERVER FROM DB
const getMikrotikConfigAC = async () => {
    const servers = await mongoose.connection.db
        .collection(collections.servers)
        .find({ ServerType: { $regex: /^AC$/i } })
        .toArray();

    console.log("Servers found:", servers);

    // pick default AC first, then any AC, then first record
    const server =
        servers.find((item) => Boolean(item.IsDefault)) ||
        servers.find((item) => normalizeServerType(item.ServerType) === "AC") ||
        servers[0];

    if (!server) {
        throw new Error("No MikroTik server found");
    }

    return {
        ...server,
        ServerType: normalizeServerType(server.ServerType),
        Port: getRouterOsPort(server.Port)
    };
};

// ✅ CHECK PPP USER EXISTS
const testMikrotikConnection = async (config = {}) => {
    const client = new RouterOSClient({
        host: config.Address,
        user: config.User,
        password: config.Password,
        port: getRouterOsPort(config.Port)
    });

    try {
        const conn = await client.connect();
        const identityRows = await conn.menu("/system/identity").getAll().catch(() => []);

        return {
            success: true,
            host: String(config.Address || "").trim(),
            port: getRouterOsPort(config.Port),
            identityName: String(identityRows?.[0]?.name || "").trim()
        };
    } finally {
        client.close();
    }
};

const checkPPPoEUser = async (username, location) => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        const result = await conn.menu("/ppp/secret").where({
            name: username
        });

        return result.length > 0;
    } catch (err) {
        console.error("❌ CHECK ERROR:", err);
        return false;
    } finally {
        client.close(); // ✅ correct
    }
};
// 🔥 ADD PPPoE USER
const addPPPoEUser = async ({ username, password, profile, location }) => {
    console.log("🔥 ADD PPP INPUT:", { username, password, profile, location });

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        console.log("✅ CONNECTED TO MIKROTIK");

        const result = await conn.menu("/ppp/secret").add({
            name: username,
            password: password,
            profile: profile,
            service: "pppoe"
        });

        console.log("✅ PPP USER CREATED:", username);
        console.log("RESULT:", result);

    } catch (err) {
        console.error("❌ ADD ERROR FULL:", err.message);
        console.error(err);
    } finally {
        client.close();
    }
};

//update ppppoeuser
const updatePPPoEUser = async ({ username, password, profile, location }) => {
    if (!username) return;

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        console.log("🔧 Updating PPP user:", username);

        // 🔥 GET USER
        const users = await conn
            .menu("/ppp/secret")
            .where({})
            .proplist([".id", "name"])
            .get();

        const target = users.find(u => u.name === username);

        if (!target || !target.id) {
            console.log("❌ USER NOT FOUND:", username);

        } else {
            const id = target.id;

            console.log("🎯 TARGET ID:", id);

            // 🔥 STEP 1: REMOVE OLD USER
            await conn.menu("/ppp/secret").remove(id);

            console.log("🗑️ OLD PPP REMOVED");
            try {

                const activeUsers = await conn
                    .menu("/ppp/active")
                    .where({ name: username })
                    .proplist([".id", "name"])
                    .get();

                if (activeUsers.length > 0) {
                    for (const active of activeUsers) {
                        if (active[".id"]) {
                            await conn.menu("/ppp/active").remove(active[".id"]);
                            console.log("🔌 ACTIVE SESSION DISCONNECTED:", username);
                        }
                    }
                } else {
                    console.log("ℹ️ No active PPP session found for:", username);
                }
            } catch (err) {
                  console.log("🗑️ OLD PPP REMOVED ERROR" + err.message);
            }
        }



        // 🔥 STEP 2: CREATE NEW USER
        await conn.menu("/ppp/secret").add({
            name: username,
            password: password,
            profile: profile,
            service: "pppoe"
        });

        console.log("✅ PPP USER RECREATED:", username);

    } catch (err) {
        console.error("❌ PPP UPDATE ERROR:", err.message);
    } finally {
        client.close();
    }
};

//disconnectPPPp
const disconnectPPPoEUser = async (username, location) => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        // 🔍 find active session
        const active = await conn.menu("/ppp/active").where({
            name: username
        });

        if (active.length > 0) {
            const id = active[0][".id"];

            // 🔥 REMOVE SESSION (force reconnect)
            await conn.menu("/ppp/active").remove({ ".id": id });

            console.log("⚡ PPP USER DISCONNECTED:", username);
        }
    } catch (err) {
        console.error("❌ DISCONNECT ERROR:", err);
    } finally {
        client.close();
    }
};

// create scheduller
// ✅ ADD DAYS
const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
};

//randomtMMSS
const getRandomTime = () => {
    const hour = "11"; // fixed hour

    const minute = String(Math.floor(Math.random() * 11)).padStart(2, "0"); // 0–10
    const second = String(Math.floor(Math.random() * 60)).padStart(2, "0"); // 0–59

    return `${hour}:${minute}:${second}`;
};

// ✅ FORMAT DATE FOR MIKROTIK
const formatMikrotikDate = (date) => {
    const months = [
        "jan", "feb", "mar", "apr", "may", "jun",
        "jul", "aug", "sep", "oct", "nov", "dec"
    ];

    const d = new Date(date);

    return { // ✅ VERY IMPORTANT
        date: `${months[d.getMonth()]}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`,
        time: getRandomTime()
    };
};

// ✅ MAIN FUNCTION
const addDisconnectScheduler = async ({ username, dueDate, location }) => {
    if (!username || !dueDate) {
        throw new Error("Missing username or dueDate");
    }

    const triggerDate = addDays(dueDate, 15);
    const { date, time } = formatMikrotikDate(triggerDate);

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        const schedulerName = `${username}`;

        console.log("🚀 Creating Scheduler:", schedulerName, date);

        await conn.menu("/system/scheduler").add({
            name: schedulerName,
            start_date: date,
            start_time: time,
            interval: "0s",

            on_event: `
        :local nowDate [/system clock get date];
        :local nowTime [/system clock get time];

        /ppp secret set [find name="${username}"] profile=dc-putol comment=("disconnected " . $nowDate . " " . $nowTime) ;

        /ppp active remove [find name="${username}"];

        /log warning ("USER DISCONNECTED: ${username} on " . $nowDate . " " . $nowTime);

        /system scheduler remove [find name="${schedulerName}"];
      `
        });

        console.log("✅ Scheduler created for:", username, "→", date);

    } catch (err) {
        console.error("❌ Scheduler ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

//remove scheduler
// ==========================
// ✅ FORCE REMOVE SCHEDULER
// ==========================
const removeScheduler = async ({ username, location }) => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        const schedulerName = `${username}`;

        console.log("🧹 Removing schedulers:", schedulerName);

        let schedulers = [];

        try {
            schedulers = await conn.menu("/system/scheduler").getAll();
            console.log("🧹 Get all scheduller");

            console.log("🧹 Filter the return");
            const matches = schedulers.filter(s => s.name === schedulerName);
            console.log("🧹 filter dun");

            if (matches != null) {
                console.log("🧹 Match not null");
                if (matches.length === 0) {
                    console.log("⚠️ No scheduler found (OK)");
                    return;
                }

                for (const s of matches) {
                    try {
                        await conn.menu("/system/scheduler").remove(s.id);
                        console.log("🗑️ Removed scheduler:", s.name);
                    } catch (err) {
                        console.log("⚠️ Skip remove:", err?.message);
                    }
                }
            }
        } catch {
            return; // ignore MikroTik empty bug
        }

    } catch (err) {
        console.log("⚠️ Scheduler remove safe:", err?.message);
    } finally {
        client.close();
    }
};


const upsertScheduler = async ({ username, dueDate, location }) => {
    if (!username || !dueDate) return;

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    const addDays = (date, days) => {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    };

    const getRandomTime = () => {
        const hour = "11";
        const minute = String(Math.floor(Math.random() * 11)).padStart(2, "0");
        const second = String(Math.floor(Math.random() * 60)).padStart(2, "0");
        return `${hour}:${minute}:${second}`;
    };

    const formatMikrotikDate = (date) => {
        const months = [
            "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec"
        ];

        const d = new Date(date);

        return {
            date: `${months[d.getMonth()]}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`,
            time: getRandomTime()
        };
    };

    try {
        const conn = await client.connect();

        const schedulerName = `${username}`;

        const trigger = addDays(dueDate, DISCONNECT_AFTER_DAYS);
        const { date, time } = formatMikrotikDate(trigger);

        console.log("🔄 UPSERT Scheduler:", schedulerName);

        let schedulers = [];

        try {
            schedulers = await conn.menu("/system/scheduler").getAll();
        } catch {
            // ignore MikroTik empty bug
        }

        const existing = schedulers.find(s => s.name === schedulerName);

        // 🔥 FIXED SCRIPT (SINGLE LINE)
        const script = `
:local nowDate [/system clock get date];
:local nowTime [/system clock get time];
:local user "${username}";
/ppp secret set [find name="$user"] profile=dc-putol comment=("disconnected " . $nowDate . " " . $nowTime);
/ppp active remove [find name="$user"];
/log warning ("USER DISCONNECTED: " . $user);
/system scheduler remove [find name="$user"];
    `;

        const oneLineScript = script
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // ==========================
        // ✏️ UPDATE IF EXISTS
        // ==========================
        if (existing) {
            console.log("✏️ Updating scheduler");

            try {
                await conn.menu("/system/scheduler").update(existing.id, {
                    start_date: date,
                    start_time: time,
                    interval: "0s",
                    on_event: oneLineScript
                });

                console.log("✅ Scheduler UPDATED");

            } catch (err) {
                console.log("⚠️ Update safe:", err?.message);
            }
        }
        // ==========================
        // ➕ CREATE IF NOT EXISTS
        // ==========================
        else {
            console.log("➕ Creating scheduler");

            await conn.menu("/system/scheduler").add({
                name: schedulerName,
                start_date: date,
                start_time: time,
                interval: "0s",
                on_event: oneLineScript
            });

            console.log("✅ Scheduler CREATED");
        }

    } catch (err) {
        console.log("⚠️ Scheduler safe:", err?.message);
    } finally {
        client.close();
    }
};

// ✅ EXPORT FUNCTIONS (BOTTOM ONLY)
const getDhcpLeasesNoComment = async () => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const leases = await conn.menu("/ip/dhcp-server/lease").getAll();

        return leases
            .filter((lease) => {
                const hasNoComment = !String(lease.comment || "").trim();
                const isBound = String(lease.status || "").trim().toUpperCase() === "BOUND";

                return hasNoComment && isBound;
            })
            .map((lease) => ({
                macAddress: lease["mac-address"] || lease.macAddress || "",
                address: lease.address || "",
                hostName: lease["host-name"] || lease.hostName || "",
                status: lease.status || ""
            }))
            .filter((lease) => lease.macAddress);
    } catch (err) {
        console.error("DHCP LEASE ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const getDhcpLeasesWithComments = async () => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const leases = await conn.menu("/ip/dhcp-server/lease").getAll();

        return leases.map((lease) => ({
            macAddress: lease["mac-address"] || lease.macAddress || "",
            address: lease.address || "",
            hostName: lease["host-name"] || lease.hostName || "",
            status: lease.status || "",
            comment: lease.comment || ""
        }));
    } catch (err) {
        console.error("DHCP LEASE COMMENT QUERY ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const isRouterOsEmptyReplyError = (err) => {
    const message = String(err?.message || "").toUpperCase();
    const errno = String(err?.errno || "").toUpperCase();

    return errno === "UNKNOWNREPLY" && message.includes("!EMPTY");
};

const parseTrafficNumber = (value) => {
    if (value === null || value === undefined || value === "") {
        return 0;
    }

    const parsed = Number(String(value).replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
};

const getTrafficValue = (row, ...keys) => {
    for (const key of keys) {
        if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== "") {
            return parseTrafficNumber(row[key]);
        }
    }

    return 0;
};

const getDhcpLeaseByMacAddress = async (macAddress) => {
    if (!macAddress) {
        return null;
    }

    const normalizedTargetMac = String(macAddress).trim().toUpperCase();
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const leases = await conn.menu("/ip/dhcp-server/lease").getAll();
        const lease = leases.find((item) => {
            const leaseMac = String(
                item["mac-address"] || item.macAddress || ""
            ).trim().toUpperCase();

            return leaseMac === normalizedTargetMac;
        });

        if (!lease) {
            return null;
        }

        return {
            id: lease[".id"] || lease.id || "",
            macAddress: lease["mac-address"] || lease.macAddress || "",
            address: lease.address || "",
            hostName: lease["host-name"] || lease.hostName || "",
            status: lease.status || "",
            comment: lease.comment || ""
        };
    } catch (err) {
        console.error("DHCP LEASE BY MAC ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const formatIpoePlanComment = (planValue) => {
    const raw = String(planValue || "").trim();
    const match = raw.match(/\d+(?:\.\d+)?/);

    if (!match) {
        return raw || "0M/0M";
    }

    const speed = match[0];
    return `${speed}M/${speed}M`;
};

const setIpoeLeaseStatic = async ({ macAddress, plan, accountName }) => {
    if (!macAddress) {
        return null;
    }

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const leaseMenu = conn.menu("/ip/dhcp-server/lease");
        const leases = await leaseMenu.getAll();

        const targetLease = leases.find((lease) => {
            const leaseMac = String(
                lease["mac-address"] || lease.macAddress || ""
            ).trim().toUpperCase();

            return leaseMac === String(macAddress).trim().toUpperCase();
        });

        if (!targetLease) {
            console.log(`⚠️ DHCP lease not found for MAC ${macAddress}`);
            return null;
        }

        const leaseId = targetLease[".id"] || targetLease.id;

        if (!leaseId) {
            throw new Error(`Lease ID not found for MAC ${macAddress}`);
        }

        const commentName = String(accountName || "billing-ipoe").trim();
        const comment = `NAME=${commentName};PLAN=${formatIpoePlanComment(plan)}`;

        try {
            await leaseMenu.where("id", leaseId).exec("make-static");
        } catch (err) {
            const leaseDynamic = String(targetLease.dynamic || "").toLowerCase();

            if (isRouterOsEmptyReplyError(err)) {
                console.log(`⚠️ MikroTik returned !empty while making lease static for ${macAddress}`);
            } else if (leaseDynamic !== "false") {
                console.error("IPOE MAKE-STATIC ERROR:", err.message);
                throw err;
            }
        }

        try {
            await leaseMenu.update({ comment }, leaseId);
        } catch (err) {
            if (isRouterOsEmptyReplyError(err)) {
                console.log(`⚠️ MikroTik returned !empty while updating lease comment for ${macAddress}`);
                return null;
            }

            throw err;
        }

        return { macAddress, comment };
    } catch (err) {
        console.error("IPOE LEASE UPDATE ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const clearIpoeLeaseComment = async ({ macAddress }) => {
    if (!macAddress) {
        return null;
    }

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const leaseMenu = conn.menu("/ip/dhcp-server/lease");
        const leases = await leaseMenu.getAll();

        const targetLease = leases.find((lease) => {
            const leaseMac = String(
                lease["mac-address"] || lease.macAddress || ""
            ).trim().toUpperCase();

            return leaseMac === String(macAddress).trim().toUpperCase();
        });

        if (!targetLease) {
            return null;
        }

        const leaseId = targetLease[".id"] || targetLease.id;

        if (!leaseId) {
            return null;
        }

        try {
            await leaseMenu.update({ comment: "" }, leaseId);
        } catch (err) {
            if (isRouterOsEmptyReplyError(err)) {
                console.log(`⚠️ MikroTik returned !empty while clearing lease comment for ${macAddress}`);
                return null;
            }

            throw err;
        }
        return { macAddress };
    } catch (err) {
        console.error("IPOE LEASE CLEAR ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const setPPPoESecretDisconnected = async ({
    username,
    password = "",
    profile = "dc-putol",
    disconnectRemark = "",
    location
}) => {
    if (!username) {
        return null;
    }

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const profiles = await conn
            .menu("/ppp/profile")
            .where({})
            .proplist(["name"])
            .get();
        const requestedProfile = String(profile || "").trim().toLowerCase();
        const matchedProfile = (profiles || []).find(
            (item) => String(item?.name || "").trim().toLowerCase() === requestedProfile
        );

        if (!matchedProfile?.name) {
            const availableProfiles = (profiles || [])
                .map((item) => String(item?.name || "").trim())
                .filter(Boolean)
                .join(", ");
            throw new Error(
                `PPPoE profile not found for disconnect: ${profile}. Available profiles: ${availableProfiles || "-"}`
            );
        }

        const users = await conn
            .menu("/ppp/secret")
            .where({})
            .proplist([".id", "name", "password"])
            .get();

        const target = users.find((user) => user.name === username);

        if (!target?.id) {
            return {
                username,
                profile: String(profile || "").trim(),
                comment: String(disconnectRemark || "").trim(),
                secretFound: false
            };
        }

        await conn.menu("/ppp/secret").update(
            {
                name: username,
                password: password || target.password || "",
                profile: matchedProfile.name,
                service: "pppoe",
                comment: String(disconnectRemark || "").trim()
            },
            target.id
        );

        try {
            const activeUsers = await conn
                .menu("/ppp/active")
                .where({ name: username })
                .proplist([".id", "name"])
                .get();

            for (const active of activeUsers || []) {
                const activeId = active[".id"] || active.id;
                if (activeId) {
                    await conn.menu("/ppp/active").remove(activeId);
                }
            }
        } catch (err) {
            if (!isRouterOsEmptyReplyError(err)) {
                throw err;
            }
        }

        return {
            username,
            profile: matchedProfile.name,
            comment: String(disconnectRemark || "").trim(),
            secretFound: true
        };
    } finally {
        client.close();
    }
};

const getClientMikrotikStatus = async ({
    authMode,
    accountName,
    macAddress
}) => {
    const normalizedAuthMode = String(authMode || "").trim().toUpperCase();

    if (!normalizedAuthMode) {
        return {
            authMode: "",
            status: "UNKNOWN",
            ipAddress: "",
            plan: "",
            rxBytes: 0,
            txBytes: 0,
            graphAvailable: false
        };
    }

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        if (normalizedAuthMode === "PPPOE") {
            const targetAccountName = String(accountName || "").trim();
            const loadPppRows = async (path) => {
                try {
                    return await conn
                        .menu(path)
                        .where({ name: targetAccountName })
                        .get();
                } catch (err) {
                    if (isRouterOsEmptyReplyError(err)) {
                        console.log(`⚠️ MikroTik returned !empty while reading ${path} for ${targetAccountName}`);
                        return [];
                    }

                    throw err;
                }
            };

            const [secrets, activeUsers] = await Promise.all([
                loadPppRows("/ppp/secret"),
                Promise.resolve([])
            ]);

            const secret = Array.isArray(secrets)
                ? secrets.find(
                    (item) => String(item.name || "").trim() === targetAccountName
                )
                : null;

            const plan = String(
                secret?.profile || ""
            ).trim();

            return {
                authMode: normalizedAuthMode,
                status: secret ? "FOUND_IN_SECRET" : "NOT FOUND",
                ipAddress: "",
                plan,
                rxBytes: 0,
                txBytes: 0,
                graphAvailable: false
            };
        }

        if (normalizedAuthMode === "IPOE") {
            const leases = await conn.menu("/ip/dhcp-server/lease").getAll();
            const normalizedMac = String(macAddress || "").trim().toUpperCase();
            const normalizedAccount = String(accountName || "").trim().toUpperCase();

            const lease = leases.find((item) => {
                const leaseMac = String(
                    item["mac-address"] || item.macAddress || ""
                ).trim().toUpperCase();
                const comment = String(item.comment || "").toUpperCase();

                return (
                    (normalizedMac && leaseMac === normalizedMac) ||
                    (normalizedAccount && comment.includes(`NAME=${normalizedAccount}`))
                );
            });

            const comment = String(lease?.comment || "");
            const planMatch = comment.match(/PLAN=([^;]+)/i);
            const leaseStatus = String(lease?.status || "").trim().toUpperCase();
            const hasComment = comment.trim() !== "";
            let status = "NO MAC FOUND";

            if (lease) {
                if (leaseStatus === "BOUND" && hasComment && String(planMatch?.[1] || "").trim().toUpperCase() !== "0M/0M") {
                    status = "ACTIVE";
                } else if (leaseStatus === "BOUND" && (!hasComment || String(planMatch?.[1] || "").trim().toUpperCase() === "0M/0M")) {
                    status = "HOLD";
                } else {
                    status = "NOT ACTIVE";
                }
            }

            return {
                authMode: normalizedAuthMode,
                status,
                ipAddress: String(lease?.address || lease?.["active-address"] || "").trim(),
                plan: String(planMatch?.[1] || "").trim(),
                macAddress: String(
                    lease?.["mac-address"] || lease?.macAddress || macAddress || ""
                ).trim().toUpperCase(),
                rxBytes: 0,
                txBytes: 0,
                graphAvailable: false
            };
        }

        return {
            authMode: normalizedAuthMode,
            status: "UNKNOWN",
            ipAddress: "",
            plan: "",
            rxBytes: 0,
            txBytes: 0,
            graphAvailable: false
        };
    } catch (err) {
        if (isRouterOsEmptyReplyError(err)) {
            console.log(`⚠️ MikroTik status query returned !empty for ${accountName || macAddress || "-"}`);
            return {
                authMode: normalizedAuthMode,
                status: "UNKNOWN",
                ipAddress: "",
                plan: "",
                rxBytes: 0,
                txBytes: 0,
                graphAvailable: false
            };
        }

        throw err;
    } finally {
        client.close();
    }
};

const addIpoeDisconnectScheduler = async ({ username, dueDate, macAddress, location }) => {
    if (!username || !dueDate || !macAddress) {
        throw new Error("Missing username, dueDate, or macAddress");
    }

    const triggerDate = addDays(dueDate, 15);
    const { date, time } = formatMikrotikDate(triggerDate);
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const schedulerName = `${username}`;
        let schedulers = [];

        try {
            schedulers = await conn.menu("/system/scheduler").getAll();
        } catch {
            schedulers = [];
        }

        const existing = schedulers.find((item) => item.name === schedulerName);

        if (existing?.id || existing?.[".id"]) {
            try {
                await conn.menu("/system/scheduler").remove(existing.id || existing[".id"]);
            } catch (err) {
                console.log("⚠️ IPOE scheduler remove before add:", err?.message);
            }
        }

        await conn.menu("/system/scheduler").add({
            name: schedulerName,
            start_date: date,
            start_time: time,
            interval: "0s",
            on_event: `
        /ip dhcp-server lease set [find mac-address="${macAddress}"] comment="NAME=${username};PLAN=0M/0M";

        /log warning ("IPOE CLIENT DISCONNECTED: ${username}");

        /system scheduler remove [find name="${schedulerName}"];
      `
        });

        console.log("✅ IPOE scheduler created for:", username, "→", date);
    } catch (err) {
        console.error("❌ IPOE SCHEDULER ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const updatePPPoEUserSafe = async ({ oldUsername, username, password, profile, location }) => {
    if (!username && !oldUsername) return;

    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const targetUsername = username || oldUsername;

        console.log("=== PPP UPDATE START ===");
        console.log("Updating PPP user:", targetUsername);
        console.log("PPP UPDATE USERNAME:", targetUsername);
        console.log("PPP UPDATE OLD USERNAME:", oldUsername || "(same)");
        console.log("PPP UPDATE PROFILE:", profile || "(empty)");

        const users = await conn
            .menu("/ppp/secret")
            .where({})
            .proplist([".id", "name"])
            .get();

        const oldTarget = users.find((user) => user.name === oldUsername);
        const target = users.find((user) => user.name === targetUsername);

        if (target?.id) {
            console.log("PPP target ID:", target.id);
        } else {
            console.log("PPP target ID: (not found, will recreate)");
        }

        const clearActiveSessions = async (nameToClear) => {
            if (!nameToClear) {
                return;
            }

            console.log("Skipping PPP active cleanup for:", nameToClear);
        };

        if (oldUsername && username && oldUsername !== username && oldTarget?.id) {
            try {
                await conn.menu("/ppp/secret").remove(oldTarget.id);
            } catch (err) {
                if (isRouterOsEmptyReplyError(err)) {
                    console.log("Old PPP secret already removed:", oldUsername);
                } else {
                    throw err;
                }
            }

            await clearActiveSessions(oldUsername);
        }

        if (target?.id) {
            try {
                await conn.menu("/ppp/secret").update(
                    {
                        name: username || targetUsername,
                        password,
                        profile,
                        service: "pppoe",
                        comment: ""
                    },
                    target.id
                );
                try {
                    await conn.menu("/ppp/secret").update(
                        { comment: "" },
                        target.id
                    );
                } catch (err) {
                    if (!isRouterOsEmptyReplyError(err)) {
                        console.log("PPP comment clear warning:", err?.message);
                    }
                }
                console.log("PPP COMMENT CLEARED:", username || targetUsername);
                console.log("PPP user updated:", username || targetUsername);
                console.log("PPP USER UPDATED:", username || targetUsername);
                await clearActiveSessions(username || targetUsername);
                console.log("=== PPP UPDATE END (IN-PLACE) ===");
                return;
            } catch (err) {
                if (isRouterOsEmptyReplyError(err)) {
                    console.log("PPP secret update returned !empty, recreating:", targetUsername);
                } else {
                    console.log("PPP secret update fallback:", err?.message);
                }
            }

            try {
                await conn.menu("/ppp/secret").remove(target.id);
            } catch (err) {
                if (isRouterOsEmptyReplyError(err)) {
                    console.log("PPP secret already removed:", targetUsername);
                } else {
                    throw err;
                }
            }

            await clearActiveSessions(targetUsername);
        }

        await conn.menu("/ppp/secret").add({
            name: username || targetUsername,
            password,
            profile,
            service: "pppoe",
            comment: ""
        });

        try {
            const refreshedUsers = await conn
                .menu("/ppp/secret")
                .where({})
                .proplist([".id", "name"])
                .get();
            const refreshedTarget = refreshedUsers.find(
                (user) => user.name === (username || targetUsername)
            );

            if (refreshedTarget?.id) {
                await conn.menu("/ppp/secret").update(
                    { comment: "" },
                    refreshedTarget.id
                );
            }
        } catch (err) {
            if (!isRouterOsEmptyReplyError(err)) {
                console.log("PPP recreated comment clear warning:", err?.message);
            }
        }

        console.log("PPP COMMENT CLEARED AFTER RECREATE:", username || targetUsername);
        console.log("PPP user updated:", username || targetUsername);
        console.log("PPP USER RECREATED:", username || targetUsername);
        await clearActiveSessions(username || targetUsername);
        console.log("=== PPP UPDATE END (RECREATE) ===");
    } catch (err) {
        console.error("=== PPP UPDATE ERROR ===");
        console.error("PPP UPDATE TARGET:", username || oldUsername || "(unknown)");
        console.error("PPP UPDATE ERROR:", err.message);
        throw err;
    } finally {
        client.close();
    }
};

const getMikrotikCheckerSnapshot = async () => {
    const server = await getMikrotikConfigAC();

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();
        const [pppSecrets, dhcpLeases] = await Promise.all([
            conn.menu("/ppp/secret").getAll().catch(() => []),
            conn.menu("/ip/dhcp-server/lease").getAll().catch(() => [])
        ]);

        return {
            pppSecrets: Array.isArray(pppSecrets) ? pppSecrets : [],
            dhcpLeases: Array.isArray(dhcpLeases) ? dhcpLeases : []
        };
    } finally {
        client.close();
    }
};

module.exports = {
    addPPPoEUser,
    addIpoeDisconnectScheduler,
    checkPPPoEUser,
    clearIpoeLeaseComment,
    getMikrotikConfigAC,
    testMikrotikConnection,
    getDhcpLeaseByMacAddress,
    getDhcpLeasesNoComment,
    getDhcpLeasesWithComments,
    setIpoeLeaseStatic,
    setPPPoESecretDisconnected,
    getClientMikrotikStatus,
    getMikrotikCheckerSnapshot,
    updatePPPoEUser: updatePPPoEUserSafe,
    disconnectPPPoEUser,
    addDisconnectScheduler,
    removeScheduler,
    upsertScheduler
};
