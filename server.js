const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const BOARD_SIZE = 15;
const ADMIN_PASSWORD = "7777"; 

// 💡 [변경됨] 모든 방의 게임 상태를 저장하는 객체
const rooms = {}; 

// 💡 [추가됨] 새로운 방을 위한 초기 게임 상태를 만드는 함수
function createNewGame() {
    return {
        board: Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0)),
        currentTurn: 1, 
        studentVotes: {}, 
        voteTimer: null,
        isGameOver: false,
        currentVoteTimeLimit: 15,
        teacherSocketId: null
    };
}

// 💡 [변경됨] board를 매개변수로 받도록 수정
function checkWin(board, r, c, player) {
    const directions = [
        [[0, 1], [0, -1]], [[1, 0], [-1, 0]], [[1, 1], [-1, -1]], [[1, -1], [-1, 1]]
    ];

    for (let dir of directions) {
        let count = 1; 
        for (let d of dir) {
            let nr = r + d[0]; let nc = c + d[1];
            while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === player) {
                count++; nr += d[0]; nc += d[1];
            }
        }
        if (player === 2 && count >= 5) return true; 
        if (player === 1 && count === 5) return true; 
    }
    return false;
}

// 렌주룰 금수 판별 (기존과 동일)
function checkRenjuFoul(board, r, c) {
    board[r][c] = 1; 
    const dirs = [ [0,1], [1,0], [1,1], [1,-1] ];
    let threeCount = 0; let fourCount = 0; let isFiveWin = false;

    for (let i = 0; i < 4; i++) {
        let [dr, dc] = dirs[i];
        let line = "";
        for (let step = -5; step <= 5; step++) {
            let nr = r + dr * step; let nc = c + dc * step;
            if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) line += "X"; 
            else if (board[nr][nc] === 1) line += "O";
            else if (board[nr][nc] === 2) line += "X";
            else line += ".";
        }

        if (line.includes("OOOOOO")) { board[r][c] = 0; return "장목 (6목 이상)"; } 
        if (line.includes("OOOOO")) { isFiveWin = true; continue; } 

        const fourRegex = /(?:\.OOOOX|XOOOO\.|\.OOOO\.|O\.OOO|OOO\.O|OO\.OO)/;
        if (fourRegex.test(line)) fourCount++;

        const threeRegex = /(?:\.\.OOO\.|\.OOO\.\.|\.O\.OO\.|\.OO\.O\.)/;
        if (threeRegex.test(line)) threeCount++;
    }

    board[r][c] = 0; 

    if (isFiveWin) return null; 
    if (fourCount >= 2) return "쌍사 (4-4)";
    if (threeCount >= 2) return "쌍삼 (3-3)";

    return null; 
}

// 💡 [변경됨] 특정 방의 투표 수를 계산
function calculateCurrentVotes(roomName) {
    const game = rooms[roomName];
    let voteCounts = {};
    for (const position of Object.values(game.studentVotes)) {
        voteCounts[position] = (voteCounts[position] || 0) + 1;
    }
    return voteCounts;
}

io.on('connection', (socket) => {
    // 💡 [추가됨] 접속 시 방 이름(room)을 가져옴 (없으면 'lobby')
    const roomName = socket.handshake.query.room || 'lobby';
    const clientPassword = socket.handshake.query.admin;

    // 해당 방에 소켓을 조인시킵니다.
    socket.join(roomName);

    // 방이 처음 만들어졌다면 초기 상태 생성
    if (!rooms[roomName]) {
        rooms[roomName] = createNewGame();
    }
    
    // 현재 조인한 방의 게임 상태를 변수에 할당
    const game = rooms[roomName];

    if (clientPassword === ADMIN_PASSWORD) {
        game.teacherSocketId = socket.id;
        console.log(`[${roomName}] ✅ 선생님 접속 완료: ${socket.id}`);
        socket.emit('roleConfirmed', 'teacher'); 
        socket.emit('settingsUpdated', { voteTime: game.currentVoteTimeLimit });
    } else {
        console.log(`[${roomName}] 🧑‍🎓 학생 접속 완료: ${socket.id}`);
        socket.emit('roleConfirmed', 'student'); 
    }

    socket.emit('updateBoard', game.board);
    if (game.isGameOver) {
        socket.emit('gameOver', game.currentTurn === 2 ? 'teacher' : 'student'); 
    } else {
        socket.emit('turnChange', game.currentTurn);
    }

    socket.on('updateSettings', (data) => {
        if (socket.id !== game.teacherSocketId) return; 

        if (data.voteTime) {
            game.currentVoteTimeLimit = data.voteTime;
            console.log(`[${roomName}] ⚙️ 설정 변경 - 투표 시간: ${game.currentVoteTimeLimit}초`);
            socket.emit('settingsUpdated', { voteTime: game.currentVoteTimeLimit });
        }
    });

    socket.on('teacherMove', (data) => {
        if (socket.id !== game.teacherSocketId || game.isGameOver) return; 

        const { row, col } = data;
        if (game.currentTurn === 1 && game.board[row][col] === 0) {
            
            const foulReason = checkRenjuFoul(game.board, row, col);
            if (foulReason) {
                socket.emit('invalidMove', `🚨 렌주룰 금수입니다!\n사유: ${foulReason}\n다른 곳에 돌을 놓아주세요.`);
                return; 
            }

            game.board[row][col] = 1; 
            // 💡 [변경됨] io.emit 대신 io.to(roomName).emit 사용 (해당 방에만 전송)
            io.to(roomName).emit('updateBoard', game.board);

            if (checkWin(game.board, row, col, 1)) {
                game.isGameOver = true;
                io.to(roomName).emit('gameOver', 'teacher');
                console.log(`[${roomName}] 🎉 선생님 승리!`);
                return;
            }

            game.currentTurn = 2; 
            io.to(roomName).emit('turnChange', game.currentTurn);
            startStudentVote(roomName); 
        }
    });

    socket.on('studentVote', (data) => {
        if (socket.id === game.teacherSocketId || game.isGameOver) return; 

        if (game.currentTurn === 2) {
            const { row, col } = data;
            const key = `${row},${col}`;
            
            if (game.board[row][col] === 0) {
                game.studentVotes[socket.id] = key;
                io.to(roomName).emit('updateVotes', calculateCurrentVotes(roomName)); 
            }
        }
    });

    socket.on('forceStopVote', () => {
        if (socket.id !== game.teacherSocketId || game.isGameOver) return; 

        if (game.currentTurn === 2 && game.voteTimer) {
            console.log(`[${roomName}] 🛑 선생님 조기 종료`);
            clearInterval(game.voteTimer); 
            game.voteTimer = null;
            processVoteResult(roomName); 
        }
    });

    socket.on('resetGame', () => {
        if (socket.id !== game.teacherSocketId) return; 

        console.log(`[${roomName}] 🔄 게임 초기화`);
        
        game.board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0));
        game.currentTurn = 1;
        game.studentVotes = {}; 
        game.isGameOver = false; 
        
        if (game.voteTimer) {
            clearInterval(game.voteTimer);
            game.voteTimer = null;
        }

        io.to(roomName).emit('updateBoard', game.board);
        io.to(roomName).emit('updateVotes', {});
        io.to(roomName).emit('gameReset'); 
        io.to(roomName).emit('turnChange', game.currentTurn);
        io.to(roomName).emit('timerUpdate', ''); 
    });

    socket.on('disconnect', () => {
        if (socket.id === game.teacherSocketId) {
            game.teacherSocketId = null;
        } else {
            if (game.studentVotes[socket.id]) {
                delete game.studentVotes[socket.id];
                if (!game.isGameOver) io.to(roomName).emit('updateVotes', calculateCurrentVotes(roomName));
            }
        }
    });
});

// 💡 [변경됨] 룸 이름을 받아서 해당 룸의 게임을 제어함
function startStudentVote(roomName) {
    const game = rooms[roomName];
    game.studentVotes = {}; 
    io.to(roomName).emit('updateVotes', {});
    
    let timeLeft = game.currentVoteTimeLimit;
    io.to(roomName).emit('timerUpdate', timeLeft);

    game.voteTimer = setInterval(() => {
        timeLeft--;
        io.to(roomName).emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(game.voteTimer);
            processVoteResult(roomName); 
        }
    }, 1000);
}

function processVoteResult(roomName) {
    const game = rooms[roomName];
    let maxVotes = 0;
    let bestMove = null;
    
    const finalVotes = calculateCurrentVotes(roomName);

    for (const [key, count] of Object.entries(finalVotes)) {
        if (count > maxVotes) {
            maxVotes = count;
            bestMove = key;
        }
    }

    if (bestMove) {
        const [row, col] = bestMove.split(',').map(Number);
        game.board[row][col] = 2; 
        io.to(roomName).emit('updateBoard', game.board);

        if (checkWin(game.board, row, col, 2)) {
            game.isGameOver = true;
            io.to(roomName).emit('gameOver', 'student');
            console.log(`[${roomName}] 🎉 학생들 승리!`);
            io.to(roomName).emit('updateVotes', {});
            return;
        }
    }

    game.currentTurn = 1; 
    io.to(roomName).emit('turnChange', game.currentTurn);
    io.to(roomName).emit('updateVotes', {}); 
}

server.listen(3000, () => {
    console.log('서버가 http://localhost:3000 에서 실행 중입니다.');
});
