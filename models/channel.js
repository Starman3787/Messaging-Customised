const mongoose = require('mongoose');

const userDataSchema = mongoose.Schema({
    _id: mongoose.Schema.Types.ObjectId,
    id: String,
    type: Number, //1 DM CHANNEL, 2 PUBLIC CHANNEL
    between: [],
    messages: []
});

module.exports = mongoose.model("channels", userDataSchema);