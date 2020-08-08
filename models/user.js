const mongoose = require('mongoose');

const userDataSchema = mongoose.Schema({
    _id: mongoose.Schema.Types.ObjectId,
    id: String,
    avatarURL: String,
    username: String
});

module.exports = mongoose.model("users", userDataSchema);