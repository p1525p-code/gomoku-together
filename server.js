const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let teacherSocketId = null;

const BOARD_SIZE = 15;
let board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0)); 
let currentTurn = 1; 
let studentVotes = {}; 
let voteTimer = null;
let isGameOver = false; 

// 💡 [변경됨] 고정되었던 시간을 변경 가능한 변수로 바꿉니다.
let currentVoteTimeLimit = 15; 

// 💡 [변경됨] 백돌(학생)은 5목 이상 승리, 흑돌(선생)은 정확히 5목이어야 승리
function checkWin(r, c, player) {
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
        if (player === 2 && count >= 5) return true; // 백돌은 5목 이상이면 무조건 승리
        if (player === 1 && count === 5) return true; // 흑돌은 정확히 5목일 때만 승리
    }
    return false;
}

// 💡 [추가됨] 흑돌(선생님)의 렌주룰 금수(3-3, 4-4, 6목)를 판별하는 인공지능 함수
function checkRenjuFoul(board, r, c) {
    board[r][c] = 1; // 임시로 돌을 놓아봄
    const dirs = [ [0,1], [1,0], [1,1], [1,-1] ];
    let threeCount = 0; let fourCount = 0; let isFiveWin = false;

    for (let i = 0; i < 4; i++) {
        let [dr, dc] = dirs[i];
        let line = "";
        // 착수 지점 기준 앞뒤 5칸씩 총 11칸의 상태를 문자열로 만듦 (O:흑, X:백, .:빈칸)
        for (let step = -5; step <= 5; step++) {
            let nr = r + dr * step; let nc = c + dc * step;
            if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) line += "X"; // 벽은 백돌과 같은 취급
            else if (board[nr][nc] === 1) line += "O";
            else if (board[nr][nc] === 2) line += "X";
            else line += ".";
        }

        if (line.includes("OOOOOO")) { board[r][c] = 0; return "장목 (6목 이상)"; } // 6목 금지
        if (line.includes("OOOOO")) { isFiveWin = true; continue; } // 5목 완성이면 승리이므로 예외

        // 4목 패턴 (돌 하나만 더 놓으면 5가 되는 형태)
        const fourRegex = /(?:\.OOOOX|XOOOO\.|\.OOOO\.|O\.OOO|OOO\.O|OO\.OO)/;
        if (fourRegex.test(line)) fourCount++;

        // 3목 패턴 (양쪽이 열려있어서 다음 턴에 4를 두 개 만들 수 있는 형태)
        const threeRegex = /(?:\.\.OOO\.|\.OOO\.\.|\.O\.OO\.|\.OO\.O\.)/;
        if (threeRegex.test(line)) threeCount++;
    }

    board[r][c] = 0; // 원상복구

    if (isFiveWin) return null; // 5목 완성이 우선순위 (금수 아님)
    if (fourCount >= 2) return "쌍사 (4-4)";
    if (threeCount >= 2) return "쌍삼 (3-3)";

    return null; // 금수가 아님 (정상 착수 가능)
}
function calculateCurrentVotes() {
    let voteCounts = {};
    for (const position of Object.values(studentVotes)) {
        voteCounts[position] = (voteCounts[position] || 0) + 1;
    }
    return voteCounts;
}

// 💡 [추가] 선생님 전용 비밀번호를 마음대로 설정하세요!
const ADMIN_PASSWORD = "7777"; 

io.on('connection', (socket) => {
    // 💡 클라이언트가 접속할 때 보낸 비밀번호(admin) 값을 확인합니다.
    const clientPassword = socket.handshake.query.admin;
    
    // 비밀번호가 일치하면 선생님, 아니면 학생으로 배정
    if (clientPassword === ADMIN_PASSWORD) {
        teacherSocketId = socket.id;
        console.log('✅ 선생님 접속 완료:', socket.id);
        socket.emit('roleConfirmed', 'teacher'); 
        socket.emit('settingsUpdated', { voteTime: currentVoteTimeLimit });
    } else {
        console.log('🧑‍🎓 학생 접속 완료:', socket.id);
        socket.emit('roleConfirmed', 'student'); 
    }

    socket.emit('updateBoard', board);
    if (isGameOver) {
        socket.emit('gameOver', currentTurn === 2 ? 'teacher' : 'student'); 
    } else {
        socket.emit('turnChange', currentTurn);
    }

    // ...(이 아래 코드(socket.on...)들은 기존과 동일하게 유지합니다)...
    socket.emit('updateBoard', board);
    if (isGameOver) {
        socket.emit('gameOver', currentTurn === 2 ? 'teacher' : 'student'); 
    } else {
        socket.emit('turnChange', currentTurn);
    }

    // 💡 [추가됨] 선생님의 설정 변경 요청 처리
    socket.on('updateSettings', (data) => {
        if (socket.id !== teacherSocketId) return; 

        if (data.voteTime) {
            currentVoteTimeLimit = data.voteTime;
            console.log(`⚙️ 설정 변경됨 - 새로운 투표 시간: ${currentVoteTimeLimit}초`);
            // 선생님 화면에 설정이 잘 반영되었다고 알려줍니다.
            socket.emit('settingsUpdated', { voteTime: currentVoteTimeLimit });
        }
    });

        socket.on('teacherMove', (data) => {
        if (socket.id !== teacherSocketId || isGameOver) return; 

        const { row, col } = data;
        if (currentTurn === 1 && board[row][col] === 0) {
            
            // 💡 [추가됨] 렌주룰 검사! 금수라면 착수를 취소하고 경고를 보냄
            const foulReason = checkRenjuFoul(board, row, col);
            if (foulReason) {
                socket.emit('invalidMove', `🚨 렌주룰 금수입니다!\n사유: ${foulReason}\n다른 곳에 돌을 놓아주세요.`);
                return; // 턴을 넘기지 않고 함수 종료
            }

            board[row][col] = 1; 
            io.emit('updateBoard', board);

            if (checkWin(row, col, 1)) {
                isGameOver = true;
                io.emit('gameOver', 'teacher');
                console.log('🎉 선생님 승리!');
                return;
            }

            currentTurn = 2; 
            io.emit('turnChange', currentTurn);
            startStudentVote(); 
        }
    });

    socket.on('studentVote', (data) => {
        if (socket.id === teacherSocketId || isGameOver) return; 

        if (currentTurn === 2) {
            const { row, col } = data;
            const key = `${row},${col}`;
            
            if (board[row][col] === 0) {
                studentVotes[socket.id] = key;
                io.emit('updateVotes', calculateCurrentVotes()); 
            }
        }
    });

    socket.on('forceStopVote', () => {
        if (socket.id !== teacherSocketId || isGameOver) return; 

        if (currentTurn === 2 && voteTimer) {
            console.log('🛑 선생님이 투표를 조기 종료했습니다.');
            clearInterval(voteTimer); 
            voteTimer = null;
            processVoteResult(); 
        }
    });

    socket.on('resetGame', () => {
        if (socket.id !== teacherSocketId) return; 

        console.log('🔄 게임이 초기화되었습니다.');
        
        board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0));
        currentTurn = 1;
        studentVotes = {}; 
        isGameOver = false; 
        
        if (voteTimer) {
            clearInterval(voteTimer);
            voteTimer = null;
        }

        io.emit('updateBoard', board);
        io.emit('updateVotes', {});
        io.emit('gameReset'); 
        io.emit('turnChange', currentTurn);
        io.emit('timerUpdate', ''); 
    });

    socket.on('disconnect', () => {
        if (socket.id === teacherSocketId) {
            teacherSocketId = null;
        } else {
            if (studentVotes[socket.id]) {
                delete studentVotes[socket.id];
                if (!isGameOver) io.emit('updateVotes', calculateCurrentVotes());
            }
        }
    });
});

function startStudentVote() {
    studentVotes = {}; 
    io.emit('updateVotes', {});
    
    // 💡 투표가 시작될 때, 현재 설정된 시간(currentVoteTimeLimit)을 사용합니다.
    let timeLeft = currentVoteTimeLimit;
    io.emit('timerUpdate', timeLeft);

    voteTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(voteTimer);
            processVoteResult(); 
        }
    }, 1000);
}

function processVoteResult() {
    let maxVotes = 0;
    let bestMove = null;
    
    const finalVotes = calculateCurrentVotes();

    for (const [key, count] of Object.entries(finalVotes)) {
        if (count > maxVotes) {
            maxVotes = count;
            bestMove = key;
        }
    }

    if (bestMove) {
        const [row, col] = bestMove.split(',').map(Number);
        board[row][col] = 2; 
        io.emit('updateBoard', board);

        if (checkWin(row, col, 2)) {
            isGameOver = true;
            io.emit('gameOver', 'student');
            console.log('🎉 학생들 승리!');
            io.emit('updateVotes', {});
            return;
        }
    }

    currentTurn = 1; 
    io.emit('turnChange', currentTurn);
    io.emit('updateVotes', {}); 
}

server.listen(3000, () => {
    console.log('서버가 http://localhost:3000 에서 실행 중입니다.');
});