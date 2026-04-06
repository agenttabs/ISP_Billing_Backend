const mongoose = require("mongoose");
const { RouterOSClient } = require("routeros-client");

// 🔥 GET SERVER FROM DB
const getMikrotikConfig = async (location) => {
    const db = mongoose.connection.db;

    const servers = await mongoose.connection.db
        .collection("network")
        .find({ location: location })
        .toArray();

    // pick first
    const server = servers[0];

    if (!server) {
        throw new Error("No MikroTik server found");
    }

    return server;
};

// ✅ CHECK PPP USER EXISTS
const checkPPPoEUser = async (username, location) => {
    const server = await getMikrotikConfig(location);

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

    const server = await getMikrotikConfig(location);

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

    const server = await getMikrotikConfig(location);

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
    const server = await getMikrotikConfig(location);

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

    const server = await getMikrotikConfig(location);

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
    const server = await getMikrotikConfig(location);

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

    const server = await getMikrotikConfig(location);

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
module.exports = {
    addPPPoEUser,
    checkPPPoEUser,
    getMikrotikConfig,
    updatePPPoEUser,
    disconnectPPPoEUser,
    addDisconnectScheduler,
    removeScheduler,
    upsertScheduler
};