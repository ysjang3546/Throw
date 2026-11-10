const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAP_SIZE = 2400;

// 무기 기본 스펙
const WEAPON_CONFIG = {
  axe: { speed: 12, damage: 45, maxDist: 480, size: 16, cooldown: 650, color: '#f87171' },
  dagger: { speed: 20, damage: 20, maxDist: 600, size: 9, cooldown: 220, color: '#38bdf8' },
  spear: { speed: 24, damage: 55, maxDist: 850, size: 14, cooldown: 850, color: '#fbbf24' },
  boomerang: { speed: 14, damage: 32, maxDist: 400, size: 13, cooldown: 500, color: '#a78bfa' },
  bomb: { speed: 11, damage: 60, maxDist: 380, size: 18, cooldown: 1100, color: '#f97316' }
};

let players = {};
let projectiles = [];
let nextProjId = 1;

// 봇(AI) 자동 채우기: 동시 접속자가 적을 때 15명의 봇 유지
const TARGET_BOTS = 15;
let bots = {};

function spawnBot(id) {
  const weapons = ['axe', 'dagger', 'spear', 'boomerang', 'bomb'];
  const botNames = ['그림자검객', '바람돌이', '철벽탱커', '폭풍던지기', '저격왕', '도끼마스터', '고스트'];
  bots[id] = {
    id: id,
    name: '[BOT] ' + botNames[Math.floor(Math.random() * botNames.length)] + Math.floor(Math.random() * 90 + 10),
    x: Math.random() * (MAP_SIZE - 200) + 100,
    y: Math.random() * (MAP_SIZE - 200) + 100,
    hp: 100,
    maxHp: 100,
    speed: 4,
    weapon: weapons[Math.floor(Math.random() * weapons.length)],
    lastShot: 0,
    dirX: 0,
    dirY: 0,
    changeDirTimer: 0,
    isBot: true
  };
}

for (let i = 1; i <= TARGET_BOTS; i++) {
  spawnBot('bot_' + i);
}

io.on('connection', (socket) => {
  // 1. 아케이드 서버 입장 (상점에서 고른 무기 들고 난입)
  socket.on('joinArena', (userData) => {
    players[socket.id] = {
      id: socket.id,
      name: userData.name || '용사',
      x: Math.random() * (MAP_SIZE - 200) + 100,
      y: Math.random() * (MAP_SIZE - 200) + 100,
      hp: userData.maxHp || 100,
      maxHp: userData.maxHp || 100,
      speed: userData.speed || 5,
      weapon: userData.weapon || 'axe',
      lastShot: 0,
      kills: 0,
      isBot: false
    };

    socket.emit('initGame', { mapSize: MAP_SIZE, myId: socket.id });
  });

  // 2. 플레이어 이동 및 조준 수신
  socket.on('playerInput', (input) => {
    const p = players[socket.id];
    if (!p) return;

    let moveX = 0;
    let moveY = 0;
    if (input.up) moveY -= 1;
    if (input.down) moveY += 1;
    if (input.left) moveX -= 1;
    if (input.right) moveX += 1;

    if (moveX !== 0 && moveY !== 0) {
      moveX *= 0.7071;
      moveY *= 0.7071;
    }

    p.x = Math.max(30, Math.min(MAP_SIZE - 30, p.x + moveX * p.speed));
    p.y = Math.max(30, Math.min(MAP_SIZE - 30, p.y + moveY * p.speed));
  });

  // 3. 무기 던지기
  socket.on('throwWeapon', (target) => {
    const p = players[socket.id];
    if (!p) return;
    const now = Date.now();
    const config = WEAPON_CONFIG[p.weapon] || WEAPON_CONFIG.axe;

    if (now - p.lastShot < config.cooldown) return;
    p.lastShot = now;

    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;

    projectiles.push({
      id: nextProjId++,
      ownerId: p.id,
      x: p.x,
      y: p.y,
      vx: (dx / dist) * config.speed,
      vy: (dy / dist) * config.speed,
      startX: p.x,
      startY: p.y,
      maxDist: config.maxDist,
      damage: config.damage,
      size: config.size,
      weaponType: p.weapon,
      color: config.color,
      isReturn: false
    });
  });

  // 4. 로비로 나가기 or 접속 종료
  const handleLeave = () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  };

  socket.on('leaveArena', handleLeave);
  socket.on('disconnect', handleLeave);
});

// 메인 게임 물리 루프 (초당 45회 연산)
setInterval(() => {
  const allCombatants = { ...players, ...bots };

  // 봇 AI 움직임 & 투척 로직
  Object.values(bots).forEach((bot) => {
    bot.changeDirTimer--;
    if (bot.changeDirTimer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      bot.dirX = Math.cos(angle);
      bot.dirY = Math.sin(angle);
      bot.changeDirTimer = Math.floor(Math.random() * 60 + 30);
    }
    bot.x = Math.max(30, Math.min(MAP_SIZE - 30, bot.x + bot.dirX * bot.speed));
    bot.y = Math.max(30, Math.min(MAP_SIZE - 30, bot.y + bot.dirY * bot.speed));

    // 가까운 적 탐색 후 투척
    const now = Date.now();
    const config = WEAPON_CONFIG[bot.weapon];
    if (now - bot.lastShot > config.cooldown * 1.5) {
      let closestTarget = null;
      let closestDist = 450;
      Object.values(allCombatants).forEach((other) => {
        if (other.id === bot.id) return;
        const d = Math.hypot(other.x - bot.x, other.y - bot.y);
        if (d < closestDist) {
          closestDist = d;
          closestTarget = other;
        }
      });

      if (closestTarget) {
        bot.lastShot = now;
        const dx = closestTarget.x - bot.x;
        const dy = closestTarget.y - bot.y;
        const dist = Math.hypot(dx, dy) || 1;
        projectiles.push({
          id: nextProjId++,
          ownerId: bot.id,
          x: bot.x,
          y: bot.y,
          vx: (dx / dist) * config.speed,
          vy: (dy / dist) * config.speed,
          startX: bot.x,
          startY: bot.y,
          maxDist: config.maxDist,
          damage: config.damage,
          size: config.size,
          weaponType: bot.weapon,
          color: config.color,
          isReturn: false
        });
      }
    }
  });

  // 투사체 이동 및 충돌 판정
  for (let i = projectiles.length - 1; i >= 0; i--) {
    let proj = projectiles[i];
    proj.x += proj.vx;
    proj.y += proj.vy;

    // 부메랑 복귀 궤적
    if (proj.weaponType === 'boomerang') {
      const traveled = Math.hypot(proj.x - proj.startX, proj.y - proj.startY);
      if (traveled > proj.maxDist && !proj.isReturn) {
        proj.isReturn = true;
      }
      if (proj.isReturn) {
        const owner = allCombatants[proj.ownerId];
        if (owner) {
          const dx = owner.x - proj.x;
          const dy = owner.y - proj.y;
          const dist = Math.hypot(dx, dy) || 1;
          proj.vx = (dx / dist) * 14;
          proj.vy = (dy / dist) * 14;
          if (dist < 20) {
            projectiles.splice(i, 1);
            continue;
          }
        }
      }
    } else {
      // 일반 투사체 최대 사거리 체크
      if (Math.hypot(proj.x - proj.startX, proj.y - proj.startY) > proj.maxDist) {
        projectiles.splice(i, 1);
        continue;
      }
    }

    // 충돌 검사
    for (let cid in allCombatants) {
      let target = allCombatants[cid];
      if (target.id === proj.ownerId) continue;

      const dist = Math.hypot(target.x - proj.x, target.y - proj.y);
      if (dist < proj.size + 20) {
        target.hp -= proj.damage;
        projectiles.splice(i, 1);

        // 사망 처리
        if (target.hp <= 0) {
          const killer = allCombatants[proj.ownerId];
          if (killer && !killer.isBot) {
            killer.kills++;
            io.to(killer.id).emit('earnReward', { gold: 50, killName: target.name });
          }

          if (target.isBot) {
            // 봇 즉시 부활
            spawnBot(target.id);
          } else {
            // 플레이어 사망 알림 및 자동 퇴장
            io.to(target.id).emit('youDied', { killer: killer ? killer.name : '장애물' });
            delete players[target.id];
          }
        }
        break;
      }
    }
  }

  // 전체 접속자에게 실시간 월드 데이터 전송
  io.emit('worldState', {
    players: { ...players, ...bots },
    projectiles: projectiles
  });
}, 1000 / 45);

server.listen(PORT, () => {
  console.log(`[서버 가동] http://localhost:${PORT} 에서 게임 실행 중`);
});