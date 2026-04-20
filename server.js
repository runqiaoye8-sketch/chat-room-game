const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// ---------- 话题库 ----------
const TOPICS = [
  { type: "topic", text: "最讨厌的饮料" },
  { type: "topic", text: "最想删除的记忆" },
  { type: "topic", text: "最尴尬的瞬间" },
  { type: "pair", text: "前任 vs 现任" },
  { type: "pair", text: "上班摸鱼 vs 认真工作" },
  { type: "pair", text: "i人 vs e人" }
];

// ---------- 特殊身份 ----------
const SPECIAL_ROLES = {
  OBSERVER: "观察者",
  FAKER: "沉默干扰者",
  JUDGE: "裁判",
  COSER: "coser"
};

const rooms = {};
const playerScores = {};

function generateRoomId() {
  return uuidv4().substring(0, 6).toUpperCase();
}

function getRandomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

function assignSpecialRoles(users) {
  const roles = [];
  const count = Math.floor(Math.random() * 4) + 1;
  const shuffled = [...users].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, Math.min(count, users.length));

  selected.forEach(user => {
    const rolePool = [SPECIAL_ROLES.OBSERVER, SPECIAL_ROLES.FAKER, SPECIAL_ROLES.JUDGE];
    const role = rolePool[Math.floor(Math.random() * rolePool.length)];
    roles.push({ userId: user.id, role });
  });
  return roles;
}

io.on("connection", (socket) => {
  console.log("用户连接:", socket.id);

  socket.on("createRoom", () => {
    const roomId = generateRoomId();
    const topic = getRandomTopic();
    rooms[roomId] = {
      id: roomId,
      users: [],
      gameStarted: false,
      speakers: [],
      anonymousMap: {},
      messages: [],
      preGameMessages: [],
      votes: {},
      creator: socket.id,
      topic: topic,
      specialRoles: [],
      coserTarget: null,
      fakeMessageUsed: {}
    };
    socket.emit("roomCreated", roomId);
    console.log(`房间 ${roomId} 已创建，话题: ${topic.text}`);
  });

  socket.on("joinRoom", ({ roomId, userName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("errorMsg", "房间不存在");
    if (room.gameStarted) return socket.emit("errorMsg", "游戏已开始");
    if (!userName?.trim()) return socket.emit("errorMsg", "请输入姓名");

    const trimmed = userName.trim();
    if (room.users.find(u => u.socketId === socket.id)) {
      return socket.emit("errorMsg", "你已在房间中");
    }

    const user = {
      id: uuidv4(),
      socketId: socket.id,
      name: trimmed
    };
    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = trimmed;
    socket.userId = user.id;

    socket.emit("joinSuccess", {
      roomId,
      userName: trimmed,
      isCreator: room.creator === socket.id,
      users: room.users.map(u => ({ id: u.id, name: u.name })),
      topic: room.topic
    });

    io.to(roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
    socket.emit("preGameHistory", room.preGameMessages);
    console.log(`${trimmed} 加入房间 ${roomId}`);
  });

  socket.on("publicMessage", (msg) => {
    const room = rooms[socket.roomId];
    if (!room || room.gameStarted) return;
    const user = room.users.find(u => u.socketId === socket.id);
    if (!user) return;

    const message = {
      senderName: user.name,
      senderId: user.id,
      text: msg,
      timestamp: Date.now()
    };
    room.preGameMessages.push(message);
    io.to(socket.roomId).emit("publicMessage", message);
  });

  socket.on("startGame", () => {
    const room = rooms[socket.roomId];
    if (!room || room.gameStarted) return;
    if (room.users.length < 2) return socket.emit("errorMsg", "至少需要2人");

    room.gameStarted = true;

    const shuffled = [...room.users].sort(() => 0.5 - Math.random());
    const speakers = shuffled.slice(0, 2);
    room.speakers = speakers.map(s => s.socketId);
    room.anonymousMap = {
      [speakers[0].socketId]: "匿名A",
      [speakers[1].socketId]: "匿名B"
    };

    room.specialRoles = assignSpecialRoles(room.users);
    room.fakeMessageUsed = {};
    room.specialRoles.forEach(r => {
      if (r.role === SPECIAL_ROLES.FAKER) room.fakeMessageUsed[r.userId] = false;
    });

    room.coserTarget = null;
    if (Math.random() < 0.2 && room.speakers.length > 0) {
      const coserSpeaker = speakers[Math.floor(Math.random() * speakers.length)];
      const otherUsers = room.users.filter(u => u.socketId !== coserSpeaker.socketId);
      if (otherUsers.length > 0) {
        const target = otherUsers[Math.floor(Math.random() * otherUsers.length)];
        room.coserTarget = {
          speakerSocketId: coserSpeaker.socketId,
          targetName: target.name
        };
      }
    }

    room.users.forEach(user => {
      const special = room.specialRoles.find(r => r.userId === user.id);
      const isSpeaker = room.speakers.includes(user.socketId);
      const anonName = isSpeaker ? room.anonymousMap[user.socketId] : null;
      let extraInfo = null;

      if (special?.role === SPECIAL_ROLES.OBSERVER) {
        const others = room.users.filter(u => u.id !== user.id);
        const target = others[Math.floor(Math.random() * others.length)];
        extraInfo = { type: "observer", seenName: target.name };
      }
      if (isSpeaker && room.coserTarget?.speakerSocketId === user.socketId) {
        extraInfo = { type: "coser", targetName: room.coserTarget.targetName };
      }

      io.to(user.socketId).emit("gameStarted", {
        isSpeaker,
        anonymousName: anonName,
        specialRole: special?.role || null,
        extraInfo,
        speakers: room.speakers.map(sockId => ({
          socketId: sockId,
          anonymousName: room.anonymousMap[sockId]
        })),
        allUsers: room.users.map(u => ({ id: u.id, name: u.name })),
        topic: room.topic
      });
    });

    room.messages = [];
    room.votes = {};
    io.to(socket.roomId).emit("gameStateChanged", { gameStarted: true });
  });

  socket.on("anonymousMessage", (msg) => {
    const room = rooms[socket.roomId];
    if (!room?.gameStarted) return;
    if (!room.speakers.includes(socket.id)) return socket.emit("errorMsg", "你已被禁言");

    const anonName = room.anonymousMap[socket.id];
    const message = { anonymousName: anonName, text: msg, timestamp: Date.now() };
    room.messages.push(message);
    io.to(socket.roomId).emit("anonymousMessage", message);
  });

  socket.on("fakeMessage", ({ anonymousAs, text }) => {
    const room = rooms[socket.roomId];
    if (!room?.gameStarted) return;

    const user = room.users.find(u => u.socketId === socket.id);
    const special = room.specialRoles.find(r => r.userId === user.id);
    if (!special || special.role !== SPECIAL_ROLES.FAKER) return;
    if (room.fakeMessageUsed[user.id]) return socket.emit("errorMsg", "假消息已使用");
    if (!["匿名A", "匿名B"].includes(anonymousAs)) return;

    room.fakeMessageUsed[user.id] = true;
    const fakeMsg = {
      anonymousName: anonymousAs,
      text: text,
      timestamp: Date.now(),
      isFake: true
    };
    room.messages.push(fakeMsg);
    io.to(socket.roomId).emit("anonymousMessage", fakeMsg);
    socket.emit("fakeUsed");
  });

  socket.on("submitVote", ({ guessForA, guessForB }) => {
    const room = rooms[socket.roomId];
    if (!room?.gameStarted) return;
    if (room.speakers.includes(socket.id)) return socket.emit("errorMsg", "发言者不能投票");

    const user = room.users.find(u => u.socketId === socket.id);
    const special = room.specialRoles.find(r => r.userId === user.id);
    const weight = special?.role === SPECIAL_ROLES.JUDGE ? 2 : 1;

    room.votes[socket.id] = { guessA: guessForA, guessB: guessForB, weight };
    socket.emit("voteConfirmed");
  });

  socket.on("endGame", () => {
    const room = rooms[socket.roomId];
    if (!room?.gameStarted) return;

    const speakerA = room.users.find(u => u.socketId === room.speakers[0]);
    const speakerB = room.users.find(u => u.socketId === room.speakers[1]);
    const speakerDetails = [
      { anonymousName: "匿名A", realName: speakerA?.name || "已离开", socketId: room.speakers[0] },
      { anonymousName: "匿名B", realName: speakerB?.name || "已离开", socketId: room.speakers[1] }
    ];

    const voteEntries = Object.entries(room.votes);
    const voteResults = [];
    let correctA = 0, correctB = 0;
    const scoreDelta = {};
    room.users.forEach(u => { scoreDelta[u.name] = 0; });

    voteEntries.forEach(([voterId, vote]) => {
      const voter = room.users.find(u => u.socketId === voterId);
      if (!voter) return;
      const isCorrectA = (vote.guessA === speakerDetails[0].realName);
      const isCorrectB = (vote.guessB === speakerDetails[1].realName);
      const weight = vote.weight || 1;

      if (isCorrectA) correctA += weight;
      if (isCorrectB) correctB += weight;

      voteResults.push({
        voterName: voter.name,
        guessA: vote.guessA,
        guessB: vote.guessB,
        correctA: isCorrectA,
        correctB: isCorrectB,
        weight
      });

      const special = room.specialRoles.find(r => r.userId === voter.id);
      if (special?.role === SPECIAL_ROLES.OBSERVER && (isCorrectA || isCorrectB)) {
        scoreDelta[voter.name] += 2;
      }
    });

    const speakerAReal = speakerDetails[0].realName;
    const speakerBReal = speakerDetails[1].realName;
    const guessedA = voteEntries.some(([_, v]) => v.guessA === speakerAReal);
    const guessedB = voteEntries.some(([_, v]) => v.guessB === speakerBReal);
    if (!guessedA && speakerA) scoreDelta[speakerA.name] += 2;
    if (!guessedB && speakerB) scoreDelta[speakerB.name] += 2;

    if (room.coserTarget) {
      const coserSpeaker = room.users.find(u => u.socketId === room.coserTarget.speakerSocketId);
      if (coserSpeaker) {
        const targetName = room.coserTarget.targetName;
        let misleadCount = 0;
        voteEntries.forEach(([_, vote]) => {
          if (vote.guessA === targetName || vote.guessB === targetName) misleadCount++;
        });
        scoreDelta[coserSpeaker.name] += misleadCount;
      }
    }

    room.specialRoles.filter(r => r.role === SPECIAL_ROLES.FAKER).forEach(r => {
      const faker = room.users.find(u => u.id === r.userId);
      if (faker && room.fakeMessageUsed[r.userId] && (!guessedA || !guessedB)) {
        scoreDelta[faker.name] += 2;
      }
    });

    Object.entries(scoreDelta).forEach(([name, delta]) => {
      if (delta > 0) playerScores[name] = (playerScores[name] || 0) + delta;
    });

    io.to(socket.roomId).emit("gameEnded", {
      speakers: speakerDetails,
      messages: room.messages,
      votes: voteResults,
      totalVotes: voteEntries.length,
      correctCountA: correctA,
      correctCountB: correctB,
      scoreDelta
    });

    room.gameStarted = false;
    room.speakers = [];
    room.anonymousMap = {};
    room.messages = [];
    room.votes = {};
    room.specialRoles = [];
    room.coserTarget = null;
    room.fakeMessageUsed = {};
    room.topic = getRandomTopic();

    io.to(socket.roomId).emit("gameStateChanged", { gameStarted: false });
    io.to(socket.roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
    io.to(socket.roomId).emit("newTopic", room.topic);
  });

  socket.on("getLeaderboard", () => {
    const sorted = Object.entries(playerScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, score]) => ({ name, score }));
    socket.emit("leaderboard", sorted);
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const idx = room.users.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) {
      const user = room.users[idx];
      room.users.splice(idx, 1);
      io.to(socket.roomId).emit("updateUsers", room.users.map(u => ({ id: u.id, name: u.name })));
      if (room.users.length === 0) delete rooms[socket.roomId];
      console.log(`${user.name} 离开房间`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));
