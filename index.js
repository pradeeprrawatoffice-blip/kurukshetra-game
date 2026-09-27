import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN || true;
const io = new Server(server, {
  cors: { origin: allowedOrigin, credentials: true },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});
const PORT = Number(process.env.PORT) || 3000;

const rooms = new Map();
const sessions = new Map();
const countdowns = new Map();
const TICK = 30;
const DT = 1 / TICK;
const ARENA = { width: 2400, height: 1200, groundY: 1010 };
const SPAWNS = [
  { x: 180, y: 900 }, { x: 420, y: 900 }, { x: 700, y: 900 }, { x: 940, y: 900 },
  { x: 1460, y: 900 }, { x: 1700, y: 900 }, { x: 1980, y: 900 }, { x: 2220, y: 900 }
];
const PLATFORMS = [
  { x: 0, y: 1010, w: 2400, h: 190, solid: true },
  { x: 210, y: 820, w: 360, h: 34 }, { x: 690, y: 690, w: 360, h: 34 },
  { x: 1080, y: 865, w: 260, h: 34 }, { x: 1410, y: 690, w: 360, h: 34 },
  { x: 1830, y: 820, w: 360, h: 34 },
  { x: 535, y: 905, w: 95, h: 105 }, { x: 1770, y: 900, w: 95, h: 110 },
  { x: 1160, y: 760, w: 80, h: 105 }, { x: 1290, y: 760, w: 80, h: 105 }
];
const chars = ['DHANVI','VEER','MAHAVEER','AGNIVEER','VANRAKSHAK','RAJVEER','SHARANG','KETU'];
const stats = {
  DHANVI:{speed:300,hp:90,damage:1.12,range:1.18}, VEER:{speed:260,hp:110,damage:1,range:1},
  MAHAVEER:{speed:220,hp:135,damage:1.08,range:.9}, AGNIVEER:{speed:275,hp:100,damage:1.04,range:1},
  VANRAKSHAK:{speed:335,hp:90,damage:.96,range:1}, RAJVEER:{speed:245,hp:125,damage:1,range:1},
  SHARANG:{speed:280,hp:95,damage:1.1,range:1.2}, KETU:{speed:360,hp:80,damage:.98,range:1}
};
// Original Indian-fantasy weapon system: no firearms.
const weapons = {
  dhanush:{name:'DHANUSH',display:'धनुष',kind:'ranged',maxAmmo:8,damage:34,fireRate:1.6,speed:1100,lifetime:1.45,pellets:1,spread:0,powerName:'AGNI BAAN',powerDamage:58,powerCooldown:7},
  talwar:{name:'TALWAR',display:'तलवार',kind:'melee',maxAmmo:Infinity,damage:44,fireRate:1.15,range:125,powerName:'SHAKTI SLASH',powerDamage:86,powerCooldown:6},
  dhaal:{name:'DHAAL',display:'ढाल',kind:'shield',maxAmmo:Infinity,damage:30,fireRate:1.0,range:105,powerName:'KAVACH',powerDamage:34,powerCooldown:8}
};
const weaponKeys = ['dhanush','talwar','dhaal'];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const makeCode=()=>{let c;do c=`KURU-${crypto.randomInt(1000,10000)}`;while(rooms.has(c));return c};
const safeLobby=r=>({code:r.code,name:r.name,maxPlayers:r.maxPlayers,mode:r.mode,botDifficulty:r.botDifficulty,map:r.map,visibility:r.visibility,approval:r.approval,locked:r.locked,state:r.state,adminId:r.adminId,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,character:p.character,ready:p.ready,isAdmin:p.id===r.adminId})),waiting:[...r.waiting.values()].map(p=>({id:p.id,name:p.name,character:p.character,status:'WAITING FOR APPROVAL'}))});
const publicRooms=()=>[...rooms.values()].filter(r=>r.visibility==='PUBLIC'&&r.state==='WAITING'&&!r.locked).map(r=>({code:r.code,name:r.name,maxPlayers:r.maxPlayers,players:r.players.size,mode:r.mode,map:r.map,approval:r.approval,locked:r.locked}));
const emitRoom=r=>{io.to(r.code).emit('room:update',safeLobby(r));io.emit('public:rooms',publicRooms())};
const getRoom=s=>{const x=sessions.get(s.id);return x?.roomCode?rooms.get(x.roomCode):null};
const requireAdmin=(s,action)=>{const r=getRoom(s);if(!r||r.adminId!==s.id){s.emit('error:message',{message:`Admin permission required for ${action}.`});return null}return r};

function rectHit(px,py,rx,ry,rw,rh){return px>=rx&&px<=rx+rw&&py>=ry&&py<=ry+rh}
function lineBlocked(x1,y1,x2,y2){
  for(let i=0;i<=12;i++){
    const t=i/12, x=x1+(x2-x1)*t, y=y1+(y2-y1)*t;
    if(PLATFORMS.some(p=>p.solid!==false&&rectHit(x,y,p.x,p.y,p.w,p.h))) return true;
  }
  return false;
}
function spawnFor(r, index){
  const base=SPAWNS[index%SPAWNS.length];
  let best={...base};
  for(let i=0;i<8;i++){
    const p=SPAWNS[(index+i)%SPAWNS.length];
    if(![...r.game.players.values()].some(q=>q.alive&&Math.hypot(q.x-p.x,q.y-p.y)<120)){best={...p};break}
  }
  return best;
}
function newGamePlayer(p,r,index){
  const st=stats[p.character]||stats.VEER, sp=spawnFor(r,index);
  return {id:p.id,name:p.name,character:p.character,x:sp.x,y:sp.y,vx:0,vy:0,w:46,h:92,onGround:false,aimX:sp.x+1,aimY:sp.y,health:st.hp,maxHealth:st.hp,alive:true,deadUntil:0,weapon:'dhanush',ammo:weapons.dhanush.maxAmmo,reloading:false,reloadUntil:0,lastShot:0,powerReadyAt:0,blocking:false,blockUntil:0,kills:0,deaths:0,score:0,input:{left:false,right:false,down:false,jump:false},seq:0};
}
function gameView(r){return {state:r.game.state,timeLeft:Math.max(0,Math.ceil((r.game.endsAt-Date.now())/1000)),players:[...r.game.players.values()].map(p=>({id:p.id,name:p.name,character:p.character,x:p.x,y:p.y,vx:p.vx,vy:p.vy,aimX:p.aimX,aimY:p.aimY,health:p.health,maxHealth:p.maxHealth,alive:p.alive,playerState:p.alive?'IN_GAME':'PLAYER_DEAD',weapon:p.weapon,ammo:p.ammo,maxAmmo:Number.isFinite(weapons[p.weapon].maxAmmo)?weapons[p.weapon].maxAmmo:0,reloading:p.reloading,powerReadyAt:p.powerReadyAt,blocking:p.blocking,powerName:weapons[p.weapon].powerName,kills:p.kills,deaths:p.deaths,score:p.score})),projectiles:r.game.projectiles.map(b=>({id:b.id,x:b.x,y:b.y,vx:b.vx,vy:b.vy,ownerId:b.ownerId,kind:b.kind}))};}
function scoreboard(r){return [...r.game.players.values()].map(p=>({id:p.id,name:p.name,character:p.character,kills:p.kills,deaths:p.deaths,score:p.score})).sort((a,b)=>b.score-a.score||b.kills-a.kills);}
function addBots(r){
  if(r.mode!=='Single Player vs Bots') return;
  const difficulty = r.botDifficulty || 'Normal';
  const count = Math.max(1, Math.min(7, r.maxPlayers-1));
  const names = ['Bot Arjun','Bot Vajra','Bot Surya','Bot Kaal','Bot Agni','Bot Rudra','Bot Nakul'];
  const botChars = ['VEER','SHARANG','MAHAVEER','AGNIVEER','VANRAKSHAK','RAJVEER','KETU'];
  for(let i=0;i<count;i++){
    const id=`bot-${r.code}-${i+1}`;
    r.game.players.set(id,newGamePlayer({id,name:names[i],character:botChars[i],ready:true},r,i+1));
    const b=r.game.players.get(id); b.isBot=true; b.botDifficulty=difficulty; b.botIndex=i;
  }
}
function updateBotAI(r,p,now){
  if(!p.isBot||!p.alive) return;
  const humans=[...r.game.players.values()].filter(q=>!q.isBot&&q.alive);
  if(!humans.length){p.input.left=p.input.right=p.input.fire=false;return;}
  let target=humans[0], best=Infinity;
  for(const h of humans){const d=Math.hypot(h.x-p.x,h.y-p.y);if(d<best){best=d;target=h;}}
  const difficulty=p.botDifficulty==='Hard'?{range:1050,aim:.98,rate:1}:p.botDifficulty==='Easy'?{range:650,aim:.72,rate:.55}:{range:850,aim:.88,rate:.78};
  const dx=target.x-p.x, dy=target.y-p.y;
  p.aimX=clamp(target.x+(Math.random()-.5)*220*(1-difficulty.aim),0,ARENA.width);
  p.aimY=clamp(target.y+(Math.random()-.5)*120*(1-difficulty.aim),0,ARENA.height);
  p.input.left=dx<-90; p.input.right=dx>90; p.input.down=false;
  p.input.fire=best<difficulty.range && !lineBlocked(p.x,p.y-25,target.x,target.y-25) && Math.random()<difficulty.rate;
  // Occasionally jump while approaching or when the target is above the bot.
  p.input.jump=(p.onGround && (dy<-110 || Math.random()<0.025));
  if(best>500 && p.weapon!=='dhanush') p.weapon='dhanush';
  if(best<=170 && p.weapon==='dhanush') p.weapon='talwar';
  if(best<=125 && p.weapon!=='dhaal' && Math.random()<0.12) p.weapon='dhaal';
  if(p.weapon==='dhaal' && best<210) p.blocking=true; else if(p.weapon!=='dhaal') p.blocking=false;
  if(p.ammo<=0 && !p.reloading && p.weapon==='dhanush') reload(p);
  if(now>=p.powerReadyAt && best<520 && Math.random()<0.025) usePower(r,p);
}

function startGame(r){
  r.state='IN_GAME';
  r.game={state:'IN_GAME',startedAt:Date.now(),endsAt:Date.now()+r.matchDuration*1000,projectiles:[],nextProjectile:1,players:new Map(),lastState:0};
  [...r.players.values()].forEach((p,i)=>r.game.players.set(p.id,newGamePlayer(p,r,i)));
  addBots(r);
  io.to(r.code).emit('game:start',{map:{width:ARENA.width,height:ARENA.height,groundY:ARENA.groundY,platforms:PLATFORMS},duration:r.matchDuration,killsTarget:r.killTarget});
  io.to(r.code).emit('game:state',gameView(r));
}
function finishGame(r){
  const pending = countdowns.get(r.code);
  if(pending){ clearInterval(pending); countdowns.delete(r.code); }
  if(!r.game||r.game.state==='MATCH_FINISHED')return;
  r.game.state='MATCH_FINISHED';r.state='FINISHED';
  io.to(r.code).emit('game:end',{scoreboard:scoreboard(r),timeLeft:0});emitRoom(r);
}
function fire(r,p){
  if(!p.alive||p.reloading)return;
  const w=weapons[p.weapon], now=Date.now(), interval=1000/w.fireRate;
  if(now-p.lastShot<interval)return;
  p.lastShot=now;
  if(w.kind==='ranged'){
    if(p.ammo<=0)return;
    p.ammo--;
    const dx=p.aimX-p.x,dy=p.aimY-(p.y-25),base=Math.atan2(dy,dx);
    const a=base+(Math.random()-.5)*w.spread;
    r.game.projectiles.push({id:r.game.nextProjectile++,ownerId:p.id,x:p.x,y:p.y-25,vx:Math.cos(a)*w.speed,vy:Math.sin(a)*w.speed,damage:w.damage*(stats[p.character]?.damage||1),life:w.lifetime,kind:'arrow'});
  } else {
    meleeAttack(r,p,w.damage,false);
  }
  io.to(r.code).emit('game:shot',{playerId:p.id,weapon:p.weapon,x:p.x,y:p.y,aimX:p.aimX,aimY:p.aimY});
}
function meleeAttack(r,p,damage,isPower){
  if(!p.alive)return;
  const w=weapons[p.weapon]; const ang=Math.atan2(p.aimY-(p.y-25),p.aimX-p.x); const range=w.range+(isPower?55:0);
  for(const target of r.game.players.values()){
    if(target.id===p.id||!target.alive)continue;
    const dx=target.x-p.x,dy=(target.y-25)-(p.y-25),dist=Math.hypot(dx,dy);
    if(dist>range)continue;
    const a=Math.atan2(dy,dx), diff=Math.abs(Math.atan2(Math.sin(a-ang),Math.cos(a-ang)));
    if(diff<=0.75) applyDamage(r,target,{ownerId:p.id,damage:damage*(stats[p.character]?.damage||1),kind:'melee'});
  }
}
function reload(p){if(p.alive&&p.weapon==='dhanush'&&!p.reloading&&p.ammo<weapons.dhanush.maxAmmo){p.reloading=true;p.reloadUntil=Date.now()+900;}}
function usePower(r,p){
  if(!p.alive||Date.now()<p.powerReadyAt)return;
  const w=weapons[p.weapon]; p.powerReadyAt=Date.now()+w.powerCooldown*1000;
  if(p.weapon==='dhanush'){
    const dx=p.aimX-p.x,dy=p.aimY-(p.y-25),base=Math.atan2(dy,dx);
    r.game.projectiles.push({id:r.game.nextProjectile++,ownerId:p.id,x:p.x,y:p.y-25,vx:Math.cos(base)*980,vy:Math.sin(base)*980,damage:w.powerDamage*(stats[p.character]?.damage||1),life:1.6,kind:'agni',splash:95});
  } else if(p.weapon==='talwar') {
    meleeAttack(r,p,w.powerDamage,true);
  } else if(p.weapon==='dhaal') {
    p.blocking=true; p.blockUntil=Date.now()+1800;
    // Shield bash at close range.
    meleeAttack(r,p,w.powerDamage,true);
  }
  io.to(r.code).emit('game:power',{playerId:p.id,weapon:p.weapon,powerName:w.powerName,cooldown:w.powerCooldown});
}
function simulate(r){
  if(!r.game||r.game.state!=='IN_GAME')return;
  const now=Date.now();
  if(now>=r.game.endsAt){finishGame(r);return;}
  for(const p of r.game.players.values()) updateBotAI(r,p,now);
  for(const p of r.game.players.values()){
    if(!p.alive){if(now>=p.deadUntil){const sp=spawnFor(r,[...r.game.players.keys()].indexOf(p.id));p.x=sp.x;p.y=sp.y;p.vx=p.vy=0;p.health=p.maxHealth;p.alive=true;p.weapon='dhanush';p.ammo=weapons.dhanush.maxAmmo;p.reloading=false;p.powerReadyAt=0;p.blocking=false;p.blockUntil=0;io.to(r.code).emit('game:respawn',{playerId:p.id,x:p.x,y:p.y});}continue;}
    if(p.reloading&&now>=p.reloadUntil){p.reloading=false;p.ammo=weapons.dhanush.maxAmmo;}
    if(p.blocking&&now>=p.blockUntil)p.blocking=false;
    const st=stats[p.character]||stats.VEER, speed=st.speed;
    const ax=(p.input.right?1:0)-(p.input.left?1:0);p.vx=ax*speed;p.vy+=1800*DT;
    if(p.input.jump&&p.onGround){p.vy=-720;p.onGround=false;}p.input.jump=false;
    const oldX=p.x, nx=clamp(p.x+p.vx*DT,24,ARENA.width-24), oldY=p.y, ny=p.y+p.vy*DT;
    p.x=nx;
    // Basic horizontal collision against solid cover/walls.
    for(const q of PLATFORMS.slice(1)){
      const overlapsY=oldY+p.h/2>q.y+2 && oldY-p.h/2<q.y+q.h-2;
      if(!overlapsY) continue;
      if(p.vx>0 && p.x+p.w/2>q.x && oldX+p.w/2<=q.x) p.x=q.x-p.w/2;
      if(p.vx<0 && p.x-p.w/2<q.x+q.w && oldX-p.w/2>=q.x+q.w) p.x=q.x+q.w+p.w/2;
    }
    p.onGround=false;p.y=ny;
    if(p.y+p.h/2>=ARENA.groundY){p.y=ARENA.groundY-p.h/2;p.vy=0;p.onGround=true;}
    else for(const q of PLATFORMS.slice(1)){
      if(p.x+p.w/2>q.x&&p.x-p.w/2<q.x+q.w&&oldY+p.h/2<=q.y&&p.y+p.h/2>=q.y&&p.vy>=0){p.y=q.y-p.h/2;p.vy=0;p.onGround=true;break;}
    }
    if(p.y>ARENA.height+200){p.health=0;killPlayer(r,p,null);}
    if(p.input.fire)fire(r,p);
  }
  for(let i=r.game.projectiles.length-1;i>=0;i--){
    const b=r.game.projectiles[i];b.x+=b.vx*DT;b.y+=b.vy*DT;b.life-=DT;
    let remove=b.life<=0||b.x<0||b.x>ARENA.width||b.y<0||b.y>ARENA.height;
    if(!remove&&PLATFORMS.some(q=>rectHit(b.x,b.y,q.x,q.y,q.w,q.h)))remove=true;
    if(!remove){for(const p of r.game.players.values()){
      if(p.id===b.ownerId||!p.alive)continue;
      if(rectHit(b.x,b.y,p.x-p.w/2,p.y-p.h/2,p.w,p.h)){
        applyDamage(r,p,b);
        if(b.kind==='agni'&&b.splash){
          for(const other of r.game.players.values()) if(other.id!==b.ownerId&&other.id!==p.id&&other.alive&&Math.hypot(other.x-b.x,other.y-b.y)<=b.splash) applyDamage(r,other,{ownerId:b.ownerId,damage:b.damage*.45,kind:'agni-splash'});
        }
        remove=true;break;
      }
    }}
    if(remove)r.game.projectiles.splice(i,1);
  }
  if(now-r.game.lastState>=33){r.game.lastState=now;io.to(r.code).emit('game:state',gameView(r));io.to(r.code).emit('game:score',scoreboard(r));}
  if([...r.game.players.values()].some(p=>p.kills>=r.killTarget)){finishGame(r);return;}
}
function killPlayer(r,victim,killer){
  if(!victim.alive)return;victim.alive=false;victim.health=0;victim.deaths++;victim.deadUntil=Date.now()+2600;
  if(killer&&killer.id!==victim.id){killer.kills++;killer.score++;io.to(r.code).emit('game:score',scoreboard(r));}
  io.to(r.code).emit('game:death',{playerId:victim.id,killerId:killer?.id||null});
}
function applyDamage(r,victim,b){
  const attacker=r.game.players.get(b.ownerId);if(!attacker||!attacker.alive)return;
  const amount=victim.blocking?b.damage*.25:b.damage;
  victim.health=clamp(victim.health-amount,0,victim.maxHealth);io.to(r.code).emit('game:damage',{playerId:victim.id,health:victim.health,maxHealth:victim.maxHealth,amount,attackerId:attacker.id,blocked:!!victim.blocking});
  if(victim.health<=0)killPlayer(r,victim,attacker);
}
function leave(s){
  const x=sessions.get(s.id);if(!x?.roomCode)return;const r=rooms.get(x.roomCode);if(!r)return;
  if(r.game?.players.has(s.id)){r.game.players.delete(s.id);if(r.game.players.size===0&&r.game.state==='IN_GAME')r.game.state='MATCH_FINISHED';}
  r.players.delete(s.id);r.waiting.delete(s.id);s.leave(r.code);
  if(r.adminId===s.id){const next=[...r.players.values()][0];r.adminId=next?.id||null;if(next)io.to(r.code).emit('room:notice',{message:`${next.name} is now Room Admin.`});}
  x.roomCode=null;if(!r.players.size&&!r.waiting.size){const pending=countdowns.get(r.code);if(pending){clearInterval(pending);countdowns.delete(r.code);}rooms.delete(r.code);return;}if(r.state==='STARTING'&&r.players.size<1){const pending=countdowns.get(r.code);if(pending){clearInterval(pending);countdowns.delete(r.code);}r.state='WAITING';emitRoom(r);return;}emitRoom(r);
}

app.use(express.static(path.join(__dirname,'../client')));
app.get('/health',(q,res)=>res.status(200).json({ok:true,service:'kurukshetra',rooms:rooms.size,time:Date.now()}));
app.get('/healthz',(q,res)=>res.status(200).send('ok'));
app.get('*splat',(q,res)=>res.sendFile(path.join(__dirname,'../client/index.html')));

io.on('connection',s=>{
  sessions.set(s.id,{id:s.id,name:'Guest',character:'DHANVI',roomCode:null});s.emit('public:rooms',publicRooms());
  s.on('room:create',(p={},ack)=>{const x=sessions.get(s.id),r={code:makeCode(),name:String(p.name||'KURUKSHETRA ROOM').slice(0,24),maxPlayers:[2,4,6,8].includes(+p.maxPlayers)?+p.maxPlayers:6,mode:['Team Battle','Single Player vs Bots'].includes(p.mode)?p.mode:'Free For All',botDifficulty:['Easy','Normal','Hard'].includes(p.botDifficulty)?p.botDifficulty:'Normal',map:'Kurukshetra Plains',visibility:p.visibility==='PUBLIC'?'PUBLIC':'PRIVATE',approval:p.approval==='OPEN'?'OPEN':'APPROVAL REQUIRED',locked:false,state:'WAITING',adminId:s.id,players:new Map(),waiting:new Map(),matchDuration:Math.max(60,Math.min(1800,+p.matchDuration||300)),killTarget:Math.max(1,Math.min(100,+p.killTarget||10))};x.name=String(p.playerName||'Player').trim().slice(0,16)||'Player';x.character=chars.includes(p.character)?p.character:'DHANVI';x.roomCode=r.code;r.players.set(s.id,{...x,ready:true});rooms.set(r.code,r);s.join(r.code);ack?.({ok:true,room:r.code});emitRoom(r)});
  s.on('room:join',(p={},ack)=>{const r=rooms.get(String(p.code||'').toUpperCase()),x=sessions.get(s.id);if(!r)return ack?.({ok:false,error:'Room does not exist.'});if(r.locked)return ack?.({ok:false,error:'Room is locked.'});if(r.state!=='WAITING')return ack?.({ok:false,error:'Match already started.'});if(r.players.size>=r.maxPlayers)return ack?.({ok:false,error:'Room is full.'});x.name=String(p.playerName||'Player').trim().slice(0,16)||'Player';x.character=chars.includes(p.character)?p.character:'DHANVI';x.roomCode=r.code;s.join(r.code);const e={...x,ready:r.approval==='OPEN'};if(r.approval==='OPEN'){r.players.set(s.id,e);ack?.({ok:true,approved:true})}else{r.waiting.set(s.id,e);ack?.({ok:true,approved:false});s.emit('room:notice',{message:'Join request sent. Waiting for Admin approval.'})}emitRoom(r)});
  s.on('room:list',()=>s.emit('public:rooms',publicRooms()));
  s.on('room:approve',({playerId},ack)=>{const r=requireAdmin(s,'approve');if(!r)return;const p=r.waiting.get(playerId);if(!p)return ack?.({ok:false,error:'Waiting player not found.'});if(r.players.size>=r.maxPlayers)return ack?.({ok:false,error:'Room is full.'});r.waiting.delete(playerId);p.ready=true;r.players.set(playerId,p);io.sockets.sockets.get(playerId)?.emit('room:approved',{room:r.code});emitRoom(r);ack?.({ok:true})});
  s.on('room:reject',({playerId},ack)=>{const r=requireAdmin(s,'reject');if(!r)return;r.waiting.delete(playerId);const t=io.sockets.sockets.get(playerId);t?.leave(r.code);t?.emit('room:rejected',{message:'Your join request was rejected.'});if(sessions.get(playerId))sessions.get(playerId).roomCode=null;emitRoom(r);ack?.({ok:true})});
  s.on('room:kick',({playerId},ack)=>{const r=requireAdmin(s,'kick');if(!r)return;if(playerId===s.id)return;r.players.delete(playerId);r.game?.players.delete(playerId);const t=io.sockets.sockets.get(playerId);t?.leave(r.code);t?.emit('room:kicked',{message:'You were removed by the Room Admin.'});if(sessions.get(playerId))sessions.get(playerId).roomCode=null;emitRoom(r);ack?.({ok:true})});
  s.on('room:lock',({locked},ack)=>{const r=requireAdmin(s,'lock/unlock');if(!r)return;r.locked=!!locked;emitRoom(r);ack?.({ok:true,locked:r.locked})});
  s.on('room:start',(p={},ack)=>{const r=requireAdmin(s,'start match');if(!r)return;if(r.players.size<1)return ack?.({ok:false,error:'At least one player is required.'});if(r.state!=='WAITING')return ack?.({ok:false,error:'Match is already starting/active.'});r.state='STARTING';emitRoom(r);let n=3;io.to(r.code).emit('game:countdown',{seconds:n});const timer=setInterval(()=>{const current=rooms.get(r.code);if(!current||current.state!=='STARTING'){clearInterval(timer);countdowns.delete(r.code);return;}n--;if(n<=0){clearInterval(timer);countdowns.delete(r.code);startGame(r);emitRoom(r)}else io.to(r.code).emit('game:countdown',{seconds:n})},1000);countdowns.set(r.code,timer);ack?.({ok:true})});
  s.on('player:input',(input={})=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(!p||r.game.state!=='IN_GAME')return;p.input.left=!!input.left;p.input.right=!!input.right;p.input.down=!!input.down;if(input.jump)p.input.jump=true;p.input.fire=!!input.fire;p.aimX=clamp(Number(input.aimX)||p.x,0,ARENA.width);p.aimY=clamp(Number(input.aimY)||p.y,0,ARENA.height);if(input.weapon&&weaponKeys.includes(input.weapon)&&!p.reloading)p.weapon=input.weapon;if(input.reload)reload(p);if(input.power)usePower(r,p)});
  s.on('player:move',(input={})=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(!p)return;p.input.left=!!input.left;p.input.right=!!input.right;p.input.down=!!input.down;if(input.jump)p.input.jump=true});
  s.on('player:aim',(a={})=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(p){p.aimX=clamp(Number(a.x)||p.x,0,ARENA.width);p.aimY=clamp(Number(a.y)||p.y,0,ARENA.height)}});
  s.on('player:shoot',()=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(r&&p)fire(r,p)});
  s.on('player:reload',()=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(p)reload(p)});
  s.on('player:power',()=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(p)usePower(r,p)});
  s.on('player:jump',()=>{const r=getRoom(s),p=r?.game?.players.get(s.id);if(p)p.input.jump=true});
  s.on('disconnect',()=>leave(s));
});
setInterval(()=>{for(const r of rooms.values())if(r.game?.state==='IN_GAME')simulate(r)},1000/TICK);
server.listen(PORT,'0.0.0.0',()=>console.log(`KURUKSHETRA listening on port ${PORT}`));

function shutdown(signal){
  console.log(`${signal}: shutting down`);
  for(const timer of countdowns.values()) clearInterval(timer);
  countdowns.clear();
  io.close(()=>server.close(()=>process.exit(0)));
  setTimeout(()=>process.exit(1),5000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

