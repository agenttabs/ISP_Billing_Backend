const mongoose = require("mongoose");
const { RouterOSClient } = require("routeros-client");

// 🔥 GET SERVER FROM DB
const getMikrotikConfig = async () => {
    const db = mongoose.connection.db;

    const server = await db.collection("Servers").findOne({}); // 🔥 ONE ROW ONLY

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
    const server = await getMikrotikConfig(location);

    const client = new RouterOSClient({
        host: server.Address,
        user: server.User,
        password: server.Password,
        port: parseInt(server.Port) || 8728
    });

    try {
        const conn = await client.connect();

        await conn.menu("/ppp/secret").add({
            name: username,
            password: password,
            profile: profile,
            service: "pppoe"
        });

        console.log("✅ PPP USER CREATED:", username);
    } catch (err) {
        console.error("❌ ADD ERROR:", err);
        throw err;
    } finally {
        client.close(); // ✅ correct
    }
};

const updatePPPoEUser = async ({
  oldUsername,
  username,
  password,
  profile,
  location
}) => {
  const server = await getMikrotikConfig(location);

  const client = new RouterOSClient({
    host: server.Address,
    user: server.User,
    password: server.Password,
    port: parseInt(server.Port) || 8728
  });

  try {
    const conn = await client.connect();

    const users = await conn
      .menu("/ppp/secret")
      .where({ name: oldUsername })
      .get();

    if (!users.length) {
      console.log("❌ PPP user not found");
      return;
    }

    const id = users[0].id;

    // 🔥 prevent duplicate username
    if (oldUsername !== username) {
      const existing = await conn
        .menu("/ppp/secret")
        .where({ name: username })
        .get();

      if (existing.length) {
        throw new Error("Username already exists in MikroTik");
      }
    }

    const updateData = {
      id,
      password,
      profile
    };

    if (oldUsername !== username) {
      updateData.name = username;
    }

    await conn.menu("/ppp/secret").set(updateData);

    console.log("✅ PPP UPDATED:", username);
  } catch (err) {
    console.error("❌ UPDATE ERROR:", err);
    throw err;
  } finally {
    client.close();
  }
};


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


// ✅ EXPORT FUNCTIONS (BOTTOM ONLY)
module.exports = {
    addPPPoEUser,
    checkPPPoEUser,
    getMikrotikConfig,
    updatePPPoEUser,
    disconnectPPPoEUser
};