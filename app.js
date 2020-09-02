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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/displays/index.html');
});

app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/displays/login.html');
});

app.post('/new', async (req, res) => {
    const user = await users.findOne({ id: req.body.accountID });
    const id = new Date().getTime();
    if (!user) {
        const newUser = new users({
            _id: mongoose.Types.ObjectId(),
            id,
            avatarURL: "https://thumbs.dreamstime.com/b/default-avatar-photo-placeholder-profile-icon-eps-file-easy-to-edit-default-avatar-photo-placeholder-profile-icon-124557887.jpg",
            username: req.body.username
        });
        newUser.save();
    }
    const channelList = await channels.find({ between: { $in: user ? user.id : id } }).lean(true);
    res.send({ id: user ? user.id : id, dms: channelList.map(channel => { return channel.id }) });
});

app.post('/update-account', (req, res) => {
    if (!req.body.self_id) return res.send(null);
    users.findOne({
        id: req.body.self_id
    },
        (err, data) => {
            if (req.body.username == data.username && req.body.avatarURL == data.avatarURL) {
                res.send(null);
            } else {
                if (req.body.username != data.username) {
                    data.username = req.body.username;
                } else {
                    data.avatarURL = req.body.avatarURL;
                }
                data.save();
                res.send({ id: req.body.self_id, username: req.body.username, avatarURL: req.body.avatarURL });
            }
        });
});

app.get('/users', (req, res) => {
    users.find({
        id: { $in: req.query.users }
    },
        (err, data) => {
            if (err) return res.send([]);
            if (!data) return res.send([]);
            res.send(data);
        }).lean(true);
});

app.post('/create-channel', (req, res) => {
    if (req.body.type == 1) {
        channels.findOne({
            type: 1,
            between: req.body.to
        },
            async (err, data) => {
                if (!data && req.body.to != req.body.from && (await users.findOne({ id: req.body.to })).lean(true)) {
                    const channel_id = new Date().getTime();
                    const newChannel = new channels({
                        _id: mongoose.Types.ObjectId(),
                        id: channel_id,
                        type: 1,
                        between: [req.body.to, req.body.from],
                        messages: []
                    });
                    newChannel.save();
                    return res.send({ channel_id });
                } else {
                    return res.send({ channel_id: null });
                }
            });
    }
});

app.get('/messages', (req, res) => {
    channels.findOne({
        id: req.query.channel_id
    },
        async (err, data) => {
            if (!data && !req.query.channel_id) {
                // create a new channel
                const channel_id = new Date().getTime();
                const newChannel = new channels({
                    _id: mongoose.Types.ObjectId(),
                    id: channel_id,
                    type: 1,
                    between: ["1", req.query.self_id],
                    messages: [{ content: `Hello! Welcome ${(await users.findOne({id: req.query.self_id})).username}!!! It appears that you currently have no friends, though you can add some to hang out with by clicking that plus button at the top and entering their id!`, id: 0, author: "1" }]
                });
                newChannel.save();
                data = newChannel;
            }
            const usersInvolved = await users.find({ id: { $in: data.between } }).lean(true);
            const send = {
                messages: [],
                channel: {
                    name: (usersInvolved.filter(val => { return val.id != req.query.self_id }))[0].username,
                    id: data.id
                },
                other_user: (usersInvolved.filter(val => { return val.id != req.query.self_id }))[0].id
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
                )
            }
            res.send(send);
        });
});

app.get('/dmchannels', (req, res) => {
    channels.find({
        id: { $in: req.query.channels },
        type: 1
    },
        async (err, datas) => {
            console.log(datas);
            if (!datas || datas.length == 0) {
                console.log("h");
                return res.send({ dmchannels: [] });
            }
            console.log(datas);
            let toReturn = [];
            for (let i = 0; i < datas.length; ++i) {
                const data = datas[i];
                const user_id = (data.between.filter(val => { return val != req.query.self_id }))[0];
                const user = await users.findOne({ id: user_id }).lean(true);
                toReturn.push({ user, channel_id: data.id });
                if ((req.query.channels.length - 1) == i) {
                    console.log(toReturn);
                    console.log("e");
                    res.send({ dmchannels: toReturn });
                }
            }
        }).select({ between: 1, id: 1 }).lean(true);
});

io.on('connection', socket => {
    console.log(socket.handshake);
    console.log('a user connected');
    console.log(socket.handshake.headers);
    socket.handshake.headers.channels.split(',').forEach(chnl => {
        console.log(chnl);
        socket.join(chnl);
    });

    socket.on('message', message => {
        console.log(message);
        if (!message.content || message.content == '') return;
        const ts = new Date().getTime();
        channels.updateOne({ id: message.channel }, { $push: { messages: { content: message.content, id: ts, author: message.author } } }, async (err, raw) => {
            //{messages: {$push: {content: message.content, id: new Date().getTime(), author: message.author}}}
            console.log(err);
            console.log(raw);
            console.log(message.channel);
            socket.emit('message', {
                author: await users.findOne({ id: message.author }),
                content: message.content,
                id: ts,
                channel_id: message.channel
            });
            socket.to(message.channel).emit('message', {
                author: await users.findOne({ id: message.author }),
                content: message.content,
                id: ts,
                channel_id: message.channel
            });
        });
    });
    socket.on('messageDeleted', message => {
        console.log(message);
        channels.updateOne({ id: message.channel }, { $pull: { messages: { id: parseInt(message.id) } } }, (err, raw) => {
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
});

http.listen(3000, () => {
    console.log('listening on *:3000');
});