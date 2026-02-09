// server.js — FIXED & PRODUCTION SAFE

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

/* -------------------- Firebase Admin -------------------- */

if (!process.env.FIREBASE_CONFIG) {
  console.error('FIREBASE_CONFIG not set');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* -------------------- App Setup -------------------- */

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

/* -------------------- Socket.IO -------------------- */

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket'], // 🚨 IMPORTANT
  pingTimeout: 60000,
  pingInterval: 25000,
});

/* -------------------- Auth Middleware -------------------- */

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));

    const decoded = await admin.auth().verifyIdToken(token);
    socket.userId = decoded.uid;

    next();
  } catch (err) {
    console.error('Socket auth failed:', err.message);
    next(new Error('Authentication failed'));
  }
});

/* -------------------- In-Memory Stores -------------------- */

const activeUsers = new Map();     // userId → Set(socketId)
const userChatRooms = new Map();   // userId → Set(chatId)
const chatParticipants = new Map(); // chatId → Set(userId)

/* -------------------- Routes -------------------- */

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    activeUsers: activeUsers.size,
    uptime: process.uptime(),
  });
});

/* -------------------- Socket Handlers -------------------- */

io.on('connection', async (socket) => {
  const authenticatedUserId = socket.userId;
  console.log('✅ Connected:', authenticatedUserId, socket.id);

  /* ---------- Presence ---------- */

  if (!activeUsers.has(authenticatedUserId)) {
    activeUsers.set(authenticatedUserId, new Set());
  }
  activeUsers.get(authenticatedUserId).add(socket.id);

  await db.collection('presence').doc(authenticatedUserId).set(
    {
      online: true,
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  socket.broadcast.emit('user_status_changed', {
    userId: authenticatedUserId,
    status: 'online',
  });

  socket.emit('authenticated', {
    userId: authenticatedUserId,
    onlineUserIds: Array.from(activeUsers.keys()),
  });

  /* ---------- Join Chat ---------- */

  socket.on('join_chat', async ({ chatId }) => {
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) return;

    const chat = chatDoc.data();
    if (!chat.participants.includes(authenticatedUserId)) return;

    socket.join(chatId);

    if (!chatParticipants.has(chatId)) {
      chatParticipants.set(chatId, new Set());
    }
    chatParticipants.get(chatId).add(authenticatedUserId);

    if (!userChatRooms.has(authenticatedUserId)) {
      userChatRooms.set(authenticatedUserId, new Set());
    }
    userChatRooms.get(authenticatedUserId).add(chatId);

    socket.to(chatId).emit('user_joined_chat', {
      userId: authenticatedUserId,
      chatId,
    });
  });

  /* ---------- Send Message ---------- */

  socket.on('send_message', async ({ chatId, text, mediaUrl, mediaType, tempId }) => {
    try {
      const msgRef = db
        .collection('chats')
        .doc(chatId)
        .collection('messages')
        .doc();

      await msgRef.set({
        senderId: authenticatedUserId,
        text: text || '',
        messageType: mediaType || 'text',
        imageUrl: mediaType === 'image' ? mediaUrl : null,
        videoUrl: mediaType === 'video' ? mediaUrl : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        readBy: {
          [authenticatedUserId]: admin.firestore.FieldValue.serverTimestamp(),
        },
        deliveredTo: {},
        edited: false,
      });

      const snap = await msgRef.get();
      const data = snap.data();

      const finalMessage = {
        id: msgRef.id,
        ...data,
        createdAt: data.createdAt.toDate().toISOString(),
        readBy: {
          [authenticatedUserId]: new Date().toISOString(),
        },
        deliveredTo: {
          [authenticatedUserId]: new Date().toISOString(),
        },
        status: 'sent',
      };

      socket.to(chatId).emit('new_message', finalMessage);
      socket.emit('message_confirmed', { tempId, message: finalMessage });

      await db.collection('chats').doc(chatId).update({
        lastMessage: {
          id: msgRef.id,
          senderId: authenticatedUserId,
          text: text || 'Media',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('Send error:', err);
      socket.emit('message_error', { tempId, error: 'Failed to send' });
    }
  });

  /* ---------- Typing ---------- */

  socket.on('typing_start', ({ chatId }) => {
    socket.to(chatId).emit('user_typing', {
      chatId,
      userId: authenticatedUserId,
      isTyping: true,
    });
  });

  socket.on('typing_stop', ({ chatId }) => {
    socket.to(chatId).emit('user_typing', {
      chatId,
      userId: authenticatedUserId,
      isTyping: false,
    });
  });

  /* ---------- Disconnect ---------- */

  socket.on('disconnect', async () => {
    console.log('❌ Disconnected:', authenticatedUserId);

    const sockets = activeUsers.get(authenticatedUserId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        activeUsers.delete(authenticatedUserId);

        await db.collection('presence').doc(authenticatedUserId).set(
          {
            online: false,
            lastSeen: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        socket.broadcast.emit('user_status_changed', {
          userId: authenticatedUserId,
          status: 'offline',
        });
      }
    }
  });
});

/* -------------------- Start Server -------------------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
