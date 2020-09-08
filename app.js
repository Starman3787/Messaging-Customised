require('dotenv').config({ path: `${process.cwd()}/config.env` });
const mongoose = require('mongoose');
const app = require('express')();
const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const users = require('./models/user.js');
const channels = require('./models/channel.js');
mongoose.connect(`mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}/${process.env.DB_PATH}`, { useNewUrlParser: true, useUnifiedTopology: true });
const jwt = require('jsonwebtoken');
let sockets = [];

function verifyToken(jwtToken) {
    try {
        return jwt.verify(jwtToken, process.env.PRIVATE_KEY);
    } catch (e) {
        return null;
    }
}

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/displays/index.html');
});

app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/displays/login.html');
});

app.get('/emoji-selector.bundle.js', (req, res) => {
    res.sendFile(__dirname + '/node_modules/emoji-selector/emoji-selector.bundle.js');
});

app.post('/new', async (req, res) => {
    const user = await users.findOne({ id: req.body.accountID }).catch(err => {
        res.status(500);
        res.json(null);
        throw err;
    });
    const id = new Date().getTime();
    if (!user) {
        const newUser = new users({
            _id: mongoose.Types.ObjectId(),
            id,
            avatarURL: "https://thumbs.dreamstime.com/b/default-avatar-photo-placeholder-profile-icon-eps-file-easy-to-edit-default-avatar-photo-placeholder-profile-icon-124557887.jpg",
            username: req.body.username
        });
        newUser.save();
        res.status(201);
    } else {
        if (req.body.username == user.username) {
            res.status(202);
        } else {
            res.status(401);
            return res.json(null);
        }
    }
    jwt.sign({ id: user?.id || id, created: new Date().getTime().toString() }, process.env.PRIVATE_KEY, { expiresIn: 86400 }, async (err, token) => {
        if (err) {
            res.status(500);
            res.json(null);
            throw err;
        }
        const channelList = await channels.find({ between: { $in: user?.id || id } }).lean(true);
        return res.json({ id: user ? user.id : id, dms: channelList.map(channel => channel.id), token });
    });
});

io.on('connection', socket => {
    if (!verifyToken(socket.handshake.headers.authorisation)) return;
    socket.handshake.headers.channels.split(',').forEach(channel => {
        return socket.join(channel);
    });
    socket.join(socket.handshake.headers.id);
    sockets.push({ id: socket.handshake.headers.id, socket });
    socket.on('message', message => {
        const tokenInfo = verifyToken(socket.handshake.headers.authorisation);
        if (!tokenInfo) return;
        if (!message.content || message.content == '') return;
        const ts = new Date().getTime();
        channels.updateOne({ id: message.channel }, { $push: { messages: { content: message.content, id: ts.toString(), author: tokenInfo.id } } }, async (err, raw) => {
            console.log(err);
            console.log(raw);
            socket.emit('message', {
                author: await users.findOne({ id: tokenInfo.id }).lean(true).select({ _id: 0 }),
                content: message.content,
                id: ts.toString(),
                channel_id: message.channel
            });
            socket.to(message.channel).emit('message', {
                author: await users.findOne({ id: tokenInfo.id }).lean(true).select({ _id: 0 }),
                content: message.content,
                id: ts.toString(),
                channel_id: message.channel
            });
        });
    });
    socket.on('messageDeleted', async message => {
        const msg = await channels.findOne({ id: message.channel, 'messages.id': message.id }).select({ _id: 0, messages: 1 });
        if (!msg) return;
        const tokenInfo = verifyToken(socket.handshake.headers.authorisation);
        if (!tokenInfo) return;
        if (!msg.messages.find(m => m.author == tokenInfo.id)) return;
        channels.updateOne({ id: message.channel }, { $pull: { messages: { id: message.id } } }, (err, raw) => {
            console.log(err);
            console.log(raw);
            socket.to(message.channel).emit('messageDeleted', {
                channel: message.channel,
                id: message.id,
            });
            socket.emit('messageDeleted', {
                channel: message.channel,
                id: message.id
            });
        });

    });

    app.post('/create-channel', (req, res) => {
        if (!req.body.type || !req.body.to || req.headers.authorisation) {
            res.status(400);
            return res.json(null);
        }
        const tokenInfo = verifyToken(req.headers.authorisation);
        if (!tokenInfo) {
            res.status(401);
            return res.json(null);
        }
        if (req.body.type == 1) {
            channels.findOne({
                type: 1,
                between: [req.body.to, tokenInfo.id]
            },
                async (err, data) => {
                    if (err) {
                        res.status(500);
                        res.json(null);
                        throw err;
                    }
                    if (!data && req.body.to != tokenInfo.id && (await users.findOne({ id: req.body.to }).lean(true))) {
                        const channel_id = new Date().getTime();
                        const newChannel = new channels({
                            _id: mongoose.Types.ObjectId(),
                            id: channel_id,
                            type: 1,
                            between: [req.body.to, tokenInfo.id],
                            messages: []
                        });
                        newChannel.save();
                        socket.to(req.body.to).emit('channelCreate', { channel_id });
                        const toJoin = sockets.find(skt => skt.id == tokenInfo.id);
                        toJoin.socket.join(channel_id);
                        res.status(201);
                        return res.json({ channel_id });
                    } else {
                        res.status(409);
                        return res.json(null);
                    }
                });
        }
    });

    app.post('/update-account', (req, res) => {
        if (!req.body.avatarURL || !req.body.username || !req.headers.authorisation) {
            res.status(400);
            return res.json(null);
        }
        const tokenInfo = verifyToken(req.headers.authorisation);
        if (!tokenInfo) {
            res.status(401);
            return res.json(null);
        }
        users.findOne({
            id: tokenInfo.id
        },
            (err, data) => {
                if (err) {
                    res.status(500);
                    res.json(null);
                    throw err;
                }
                if (req.body.username == data.username && req.body.avatarURL == data.avatarURL) {
                    res.status(406);
                    return res.json(null);
                } else {
                    if (req.body.username != data.username) {
                        data.username = req.body.username;
                    } else {
                        data.avatarURL = req.body.avatarURL;
                    }
                    data.save();
                    res.status(202);
                    return res.json({ id: tokenInfo.id, username: req.body.username, avatarURL: req.body.avatarURL });
                }
            });
    });

    app.get('/users', (req, res) => {
        if (!req.query.users || req.query.users.length == 0 || !req.headers.authorisation) {
            res.status(400);
            return res.json(null);
        }
        const tokenInfo = verifyToken(req.headers.authorisation);
        if (!tokenInfo) {
            res.status(401);
            return res.json(null);
        }
        users.find({
            id: { $in: req.query.users }
        },
            (err, data) => {
                if (err) {
                    res.status(500);
                    res.json(null);
                    throw err;
                }
                if (!data) {
                    res.status(404);
                    return res.json({ users: [] });
                }
                res.status(200);
                return res.json({ users: data });
            }).lean(true).select({ _id: 0 });
    });

    app.get('/messages', (req, res) => {
        if (!req.headers.authorisation) {
            res.status(400);
            return res.json(null);
        }
        const tokenInfo = verifyToken(req.headers.authorisation);
        if (!tokenInfo) {
            res.status(401);
            return res.json(null);
        }
        channels.findOne({
            id: req.query.channel_id,
            between: tokenInfo.id
        },
            async (err, data) => {
                if (err) {
                    res.status(500);
                    res.json(null);
                    throw err;
                }
                if (!data && req.query.channel_id == 'undefined') {
                    // create a new channel
                    const channel_id = new Date().getTime();
                    const newChannel = new channels({
                        _id: mongoose.Types.ObjectId(),
                        id: channel_id,
                        type: 1,
                        between: ["1", tokenInfo.id],
                        messages: [{ content: `Hello! Welcome ${(await users.findOne({ id: tokenInfo.id }).lean(true).select({ _id: 0 })).username}!!! It appears that you currently have no friends, though you can add some to hang out with by clicking that plus button at the top and entering their id!`, id: "0", author: "1" }]
                    });
                    newChannel.save();
                    data = newChannel;
                    res.status(201);
                } else {
                    res.status(200);
                }
                const usersInvolved = await users.find({ id: { $in: data.between } }).lean(true);
                const send = {
                    messages: [],
                    channel: {
                        name: (usersInvolved.filter(val => { return val.id != tokenInfo.id }))[0].username,
                        id: data.id
                    },
                    other_user: (usersInvolved.filter(val => { return val.id != tokenInfo.id }))[0].id
                };
                const toFetch = (req.query.number && req.query.number <= 50 ? req.query.number : 50);
                const messages = data.messages.slice(Math.max(data.messages.length - toFetch, 0));
                for (const message of messages) {
                    send.messages.push(
                        {
                            content: message.content,
                            author: {
                                username: usersInvolved.find(user => user.id == message.author).username,
                                avatarURL: usersInvolved.find(user => user.id == message.author).avatarURL,
                                id: message.author
                            },
                            id: message.id,
                            channel_id: data.id
                        }
                    );
                }
                return res.json(send);
            });
    });

    app.get('/dmchannels', (req, res) => {
        if (!req.query.channels || req.query.channels.length == 0 || !req.headers.authorisation) {
            res.status(400);
            return res.json(null);
        }
        const tokenInfo = verifyToken(req.headers.authorisation);
        if (!tokenInfo) {
            res.status(401);
            return res.json(null);
        }
        channels.find({
            id: { $in: req.query.channels },
            between: tokenInfo.id,
            type: 1
        },
            async (err, datas) => {
                if (err) {
                    res.status(500);
                    res.json(null);
                    throw err;
                }
                if (!datas || datas.length == 0) {
                    res.status(404);
                    return res.json({ dmchannels: [] });
                }
                let toReturn = [];
                for (let i = 0; i < datas.length; ++i) {
                    const data = datas[i];
                    const user_id = (data.between.filter(val => val != tokenInfo.id))[0];
                    const user = await users.findOne({ id: user_id }).lean(true).select({ _id: 0 });
                    toReturn.push({ user, channel_id: data.id });
                    if ((req.query.channels.length - 1) == i) {
                        res.status(200);
                        return res.json({ dmchannels: toReturn });
                    }
                }
            }).select({ between: 1, id: 1 }).lean(true);
    });
});

http.listen(3000, () => {
    console.log('listening on *:3000');
});