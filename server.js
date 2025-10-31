const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Game state
let game = {
  started: false,
  deck: [],
  players: {},  // socketId -> { name, alive }
  round: [],    // [{socketId, name, card, value}]
  joinTimer: null,
  drawTimer: null
};

// Helpers
function createDeck() {
  const suits = ["♠","♥","♦","♣"];
  const values = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const deck = [];
  for (const s of suits) for (const v of values) deck.push({ card: `${v}${s}`, value: values.indexOf(v)+2 });
  return shuffle(deck);
}

function shuffle(array){
  for (let i=array.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [array[i],array[j]]=[array[j],array[i]];
  }
  return array;
}

function getAlivePlayers() {
  return Object.keys(game.players).filter(id => game.players[id].alive);
}

function getPublicPlayers() {
  return Object.keys(game.players).map(id => {
    const p = game.players[id];
    return { name: p.name, alive: p.alive };
  });
}

function autoDrawRemaining() {
  const alive = getAlivePlayers();
  alive.forEach(id => {
    if (!game.round.find(r => r.socketId === id)) {
      const card = game.deck.pop();
      const p = game.players[id];
      game.round.push({ socketId: id, name: p.name, card: card.card, value: card.value });
      io.emit("message", `🃏 ${p.name} auto-drew ${card.card}`);
    }
  });
  endRound();
}

// End round logic
function endRound() {
  const loser = game.round.reduce((a,b)=>a.value<b.value?a:b);
  game.players[loser.socketId].alive=false;
  io.emit("message", `💀 ${loser.name} is out (had ${loser.card})`);
  
  const remaining = Object.values(game.players).filter(p=>p.alive);
  if (remaining.length===1) {
    io.emit("message", `🏆 Congratulations ${remaining[0].name}! You won the game!`);
    game.started=false;
  } else if (remaining.length===0){
    io.emit("message", "⚠️ No players left. Game ended.");
    game.started=false;
  } else {
    io.emit("message", "➡️ Next round! Type !d to draw within 30 seconds!");
    game.round=[];
    startDrawTimer();
  }
  io.emit("players", getPublicPlayers());
}

// Start draw timer (30s)
function startDrawTimer(){
  clearTimeout(game.drawTimer);
  let countdown = 30;
  const interval = setInterval(()=>{
    if (!game.started) return clearInterval(interval);
    if (countdown===10 || countdown===5 || countdown===3 || countdown===1){
      io.emit("message", `⏱️ ${countdown} seconds left to draw!`);
    }
    countdown--;
    if (countdown<0){
      clearInterval(interval);
      autoDrawRemaining();
    }
  },1000);
  game.drawTimer=interval;
}

// Start join timer (30s)
function startJoinTimer(){
  clearTimeout(game.joinTimer);
  let countdown=30;
  const interval = setInterval(()=>{
    if (!game.started) return clearInterval(interval);
    if (countdown===10 || countdown===5 || countdown===3 || countdown===1){
      io.emit("message", `⏱️ ${countdown} seconds left to join!`);
    }
    countdown--;
    if (countdown<0){
      clearInterval(interval);
      io.emit("message","✅ Join time ended. Round 1 begins! Type !d to draw your card!");
      startDrawTimer();
    }
  },1000);
  game.joinTimer=interval;
}

// Socket connection
io.on("connection", (socket)=>{
  console.log("👋 socket connected:", socket.id);
  socket.emit("message","Welcome! Please set a temporary username first.");

  socket.on("setName", (name)=>{
    name = String(name||"Guest").trim().slice(0,24)||"Guest";
    game.players[socket.id]={name, alive:true};
    io.emit("message", `👤 ${name} joined the room.`);
    io.emit("players", getPublicPlayers());
  });

  socket.on("chat",(msg)=>{
    const user=game.players[socket.id];
    if (!user){
      socket.emit("message","⚠️ You must set a username first.");
      return;
    }
    msg=String(msg||"").trim();
    if (msg==="!start"){
      if (game.started){
        socket.emit("message","⚠️ Game already running.");
        return;
      }
      game.started=true;
      game.deck=createDeck();
      Object.keys(game.players).forEach(id=>game.players[id].alive=true);
      game.round=[];
      io.emit("message", `🏏 Game started by ${user.name}! Type !j to join within 30 seconds!`);
      startJoinTimer();
      io.emit("players", getPublicPlayers());
      return;
    }
    if (msg==="!j"){
      if (!game.started){
        socket.emit("message","⚠️ No game started. Type !start to begin.");
        return;
      }
      game.players[socket.id].alive=true;
      io.emit("message", `✅ ${user.name} joined the game.`);
      io.emit("players", getPublicPlayers());
      return;
    }
    if (msg==="!d"){
      if (!game.started){
        socket.emit("message","⚠️ No game running. Type !start to begin.");
        return;
      }
      const p=game.players[socket.id];
      if (!p.alive){
        socket.emit("message","❌ You are eliminated.");
        return;
      }
      if (game.round.find(r=>r.socketId===socket.id)){
        socket.emit("message","⚠️ You already drew your card this round.");
        return;
      }
      const card=game.deck.pop();
      game.round.push({ socketId:socket.id, name:p.name, card:card.card, value:card.value });
      io.emit("message", `🃏 ${p.name} drew ${card.card}`);
      // check if all alive players drew
      if (game.round.length===getAlivePlayers().length){
        clearTimeout(game.drawTimer);
        endRound();
      }
      return;
    }
    // default chat
    io.emit("message", `${user.name}: ${msg}`);
  });

  socket.on("disconnect", ()=>{
    const p=game.players[socket.id];
    if (p){
      io.emit("message", `❌ ${p.name} disconnected.`);
      delete game.players[socket.id];
      io.emit("players", getPublicPlayers());
    }
    console.log("socket disconnected:", socket.id);
  });
});

server.listen(PORT,()=>console.log(`Server listening on port ${PORT}`));
