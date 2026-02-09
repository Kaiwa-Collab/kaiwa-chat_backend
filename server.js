// server.js
// WebSocket Chat Server with Firebase Integration
// This reduces Firestore reads by 90%+ while maintaining real-time functionality

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

// Initialize Firebase Admin
// For production: Use environment variable
// For development: Use serviceAccountKey.json file
// Initialize Firebase Admin
let serviceAccount;

if (!process.env.FIREBASE_CONFIG) {
  console.error('FIREBASE_CONFIG not set');
  process.exit(1);
}

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
  serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, '\n');
  console.log('Firebase config loaded');
} catch (err) {
  console.error('Invalid FIREBASE_CONFIG JSON', err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

app.use(express.json());

// Socket.IO configuration
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'], // Support both WebSocket and polling
  allowEIO3: true // Support older clients
});

// In-memory store for active connections
const activeUsers = new Map(); // userId -> Set of socketIds
const userChatRooms = new Map(); // userId -> Set of chatIds
const chatParticipants = new Map(); // chatId -> Set of userIds

// Helper: Verify Firebase token
async function verifyToken(token) {
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return decodedToken.uid;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

// Helper: Get user profile (cached)
const userProfileCache = new Map();
async function getUserProfile(userId) {
  if (userProfileCache.has(userId)) {
    return userProfileCache.get(userId);
  }
  
  try {
    const doc = await db.collection('profile').doc(userId).get();
    const data = doc.exists ? doc.data() : null;
    
    if (data) {
      userProfileCache.set(userId, data);
      // Cache for 5 minutes
      setTimeout(() => userProfileCache.delete(userId), 5 * 60 * 1000);
    }
    
    return data;
  } catch (error) {
    return null;
  }
}

// Health check endpoint (important for cloud platforms)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeUsers: activeUsers.size,
    activeChats: chatParticipants.size,
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Chat WebSocket Server Running',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      health: '/health',
      messages: '/api/messages/:chatId'
    }
  });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('No token'));
    }

    const decoded = await admin.auth().verifyIdToken(token);
    socket.userId = decoded.uid;
    return next();
  } catch (err) {
    return next(new Error('Authentication failed'));
  }
});


// Socket.io Connection Handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  let authenticatedUserId = null;

  // Authentication
  socket.on('authenticate', async (data) => {
    const { token } = data;
    
    const userId = await verifyToken(token);
    if (!userId) {
      socket.emit('auth_error', { message: 'Invalid token' });
      socket.disconnect();
      return;
    }
    
    authenticatedUserId = userId;
    
    // Track active user
    if (!activeUsers.has(userId)) {
      activeUsers.set(userId, new Set());
    }
    activeUsers.get(userId).add(socket.id);
    
    // Update online status in Firestore (single write)
    try {
      await db.collection('presence').doc(userId).set({
        online: true,
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id)
      }, { merge: true });
    } catch (error) {
      console.error('Error updating presence:', error);
    }
    
    // Emit to user's contacts that they're online
    socket.broadcast.emit('user_status_changed', {
      userId,
      status: 'online'
    });
    
    // Send current online user IDs so client can show presence without Firestore reads
    const onlineUserIds = Array.from(activeUsers.keys());
    socket.emit('authenticated', { userId, onlineUserIds });
    console.log(`User ${userId} authenticated`);
  });

  // Join chat room
  socket.on('join_chat', async (data) => {
    if (!authenticatedUserId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    const { chatId } = data;
    
    try {
      // Verify user is participant (single read)
      const chatDoc = await db.collection('chats').doc(chatId).get();
      if (!chatDoc.exists) {
        socket.emit('error', { message: 'Chat not found' });
        return;
      }
      
      const chatData = chatDoc.data();
      if (!chatData.participants.includes(authenticatedUserId)) {
        socket.emit('error', { message: 'Not a participant' });
        return;
      }
      
      // Join socket room
      socket.join(chatId);
      
      // Track user's chats
      if (!userChatRooms.has(authenticatedUserId)) {
        userChatRooms.set(authenticatedUserId, new Set());
      }
      userChatRooms.get(authenticatedUserId).add(chatId);
      
      // Track chat participants
      if (!chatParticipants.has(chatId)) {
        chatParticipants.set(chatId, new Set());
      }
      chatParticipants.get(chatId).add(authenticatedUserId);
      
      console.log(`User ${authenticatedUserId} joined chat ${chatId}`);
      
      // Notify other participants that user is active in chat
      socket.to(chatId).emit('user_joined_chat', {
        userId: authenticatedUserId,
        chatId
      });
    } catch (error) {
      console.error('Error joining chat:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  // Leave chat room
  socket.on('leave_chat', (data) => {
    const { chatId } = data;
    socket.leave(chatId);
    
    if (userChatRooms.has(authenticatedUserId)) {
      userChatRooms.get(authenticatedUserId).delete(chatId);
    }
    
    if (chatParticipants.has(chatId)) {
      chatParticipants.get(chatId).delete(authenticatedUserId);
    }
    
    socket.to(chatId).emit('user_left_chat', {
      userId: authenticatedUserId,
      chatId
    });
  });

  // Send message (real-time via WebSocket + persist to Firebase)
  socket.on('send_message', async (data) => {
    if (!authenticatedUserId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    const { chatId, text, mediaUrl, mediaType, tempId } = data;
    
    try {
      // Optimistic update - emit immediately to sender
      const optimisticMessage = {
        id: tempId,
        senderId: authenticatedUserId,
        text: text || '',
        messageType: mediaType || 'text',
        imageUrl: mediaType === 'image' ? mediaUrl : null,
        videoUrl: mediaType === 'video' ? mediaUrl : null,
        createdAt: new Date().toISOString(),
        readBy: { [authenticatedUserId]: new Date().toISOString() },
        deliveredTo: { [authenticatedUserId]: admin.firestore.FieldValue.serverTimestamp()},
        status: 'sending'
      };
      
      // socket.emit('message_sent', optimisticMessage);
      
      // Persist to Firebase (single write)
      const messageRef = db.collection('chats').doc(chatId).collection('messages').doc();
      
      const messageData = {
        senderId: authenticatedUserId,
        text: text || '',
        messageType: mediaType || 'text',
        imageUrl: mediaType === 'image' ? mediaUrl : null,
        videoUrl: mediaType === 'video' ? mediaUrl : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        readBy: { [authenticatedUserId]: admin.firestore.FieldValue.serverTimestamp() },
        deliveredTo: {},
        edited: false
      };
      
      await messageRef.set(messageData);
      
      // Get actual server timestamp
      const savedDoc = await messageRef.get();
      const savedData = savedDoc.data();
      
      const finalMessage = {
  id: messageRef.id,
  ...savedData,
  createdAt: savedData.createdAt?.toDate().toISOString(),
  readBy: {
    [authenticatedUserId]:
      savedData.readBy[authenticatedUserId]?.toDate().toISOString()
  },
  deliveredTo: {
    [authenticatedUserId]: new Date().toISOString()
  },
  status: 'sent'
};

      
      // Emit to all participants in the chat room EXCEPT sender
      socket.to(chatId).emit('new_message', finalMessage);
      
      // Send confirmation to sender with real ID
      socket.emit('message_confirmed', {
        tempId,
        message: finalMessage
      });
      
      // Update last message (single write)
      await db.collection('chats').doc(chatId).update({
        lastMessage: {
          id: messageRef.id,
          senderId: authenticatedUserId,
          text: text || (mediaType === 'image' ? '📷 Photo' : mediaType === 'video' ? '📹 Video' : 'Media'),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Emit chat updated event to all user's devices
      const participants = chatParticipants.get(chatId) || new Set();
      participants.forEach(participantId => {
        const sockets = activeUsers.get(participantId);
        if (sockets) {
          sockets.forEach(socketId => {
            io.to(socketId).emit('chat_updated', {
              chatId,
              lastMessage: finalMessage
            });
          });
        }
      });
      
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('message_error', {
        tempId,
        error: 'Failed to send message'
      });
    }
  });

  // Mark messages as delivered (batch update)
  socket.on('mark_delivered', async (data) => {
    if (!authenticatedUserId) return;
    
    const { chatId, messageIds } = data;
    
    try {
      const batch = db.batch();
      
      messageIds.forEach(messageId => {
        const msgRef = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
        batch.update(msgRef, {
          [`deliveredTo.${authenticatedUserId}`]: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      
      await batch.commit();
      
      // Notify sender that messages were delivered
      socket.to(chatId).emit('messages_delivered', {
        userId: authenticatedUserId,
        messageIds
      });
      
    } catch (error) {
      console.error('Error marking delivered:', error);
    }
  });

  // Mark messages as read (batch update)
  socket.on('mark_read', async (data) => {
    if (!authenticatedUserId) return;
    
    const { chatId, messageIds } = data;
    
    try {
      const batch = db.batch();
      
      messageIds.forEach(messageId => {
        const msgRef = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
        batch.update(msgRef, {
          [`readBy.${authenticatedUserId}`]: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      
      await batch.commit();
      
      // Notify sender that messages were read
      socket.to(chatId).emit('messages_read', {
        userId: authenticatedUserId,
        messageIds
      });
      
    } catch (error) {
      console.error('Error marking read:', error);
    }
  });

  // Typing indicator (real-time only, no DB write)
  socket.on('typing_start', (data) => {
    if (!authenticatedUserId) return;
    
    const { chatId } = data;
    socket.to(chatId).emit('user_typing', {
      userId: authenticatedUserId,
      chatId,
      isTyping: true
    });
  });

  socket.on('typing_stop', (data) => {
    if (!authenticatedUserId) return;
    
    const { chatId } = data;
    socket.to(chatId).emit('user_typing', {
      userId: authenticatedUserId,
      chatId,
      isTyping: false
    });
  });

  // Message updated (e.g. deleted for everyone - broadcast placeholder to other participants)
  socket.on('message_updated', async (data) => {
    if (!authenticatedUserId) return;

    const { chatId, message } = data;
    if (!chatId || !message) return;

    try {
      const chatDoc = await db.collection('chats').doc(chatId).get();
      if (!chatDoc.exists || !chatDoc.data().participants.includes(authenticatedUserId)) {
        return;
      }
      socket.to(chatId).emit('message_updated', { chatId, message });
    } catch (error) {
      console.error('Error broadcasting message_updated:', error);
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    if (authenticatedUserId) {
      // Remove from active users
      const userSockets = activeUsers.get(authenticatedUserId);
      if (userSockets) {
        userSockets.delete(socket.id);
        
        // If user has no more active connections
        if (userSockets.size === 0) {
          activeUsers.delete(authenticatedUserId);
          
          try {
            // Update presence (single write)
            await db.collection('presence').doc(authenticatedUserId).set({
              online: false,
              lastSeen: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // Notify contacts
            socket.broadcast.emit('user_status_changed', {
              userId: authenticatedUserId,
              status: 'offline',
              lastSeen: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error updating presence on disconnect:', error);
          }
        }
      }
      
      // Clean up chat rooms
      const userChats = userChatRooms.get(authenticatedUserId);
      if (userChats) {
        userChats.forEach(chatId => {
          const participants = chatParticipants.get(chatId);
          if (participants) {
            participants.delete(authenticatedUserId);
          }
        });
        userChatRooms.delete(authenticatedUserId);
      }
    }
  });
});

// REST API for fetching message history (pagination to reduce reads)
app.get('/api/messages/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { limit = 50, before } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const userId = await verifyToken(token);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Verify user is participant
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists || !chatDoc.data().participants.includes(userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    let query = db.collection('chats')
      .doc(chatId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit));
    
    if (before) {
      query = query.startAfter(new Date(before));
    }
    
    const snapshot = await query.get();
    const messages = snapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate().toISOString()
      }))
      .filter(msg => {
        const deletedFor = msg.deletedFor || {};
        return !deletedFor[userId];
      });
    
    res.json({
      messages,
      hasMore: snapshot.size === parseInt(limit)
    });
    
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Use PORT from environment variable (required for most cloud platforms)
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});








