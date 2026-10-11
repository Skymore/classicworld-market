package msnet

import (
	crand "crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	mrand "math/rand/v2"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/zhyonc/msnet/internal/crypt"
)

type clientSocket struct {
	id               int32
	delegate         CClientSocketDelegate
	sock             net.Conn
	addr             net.Addr
	recvCipherType   CipherType
	sendCipherType   CipherType
	recvIV           []byte
	sendIV           []byte
	CPMap            map[uint16]uint16
	aliveStopChan    chan struct{}
	lastAliveAckTime time.Time
	sendMu           sync.Mutex
}

func NewCClientSocket(delegate CClientSocketDelegate, conn net.Conn, recvIV []byte, sendIV []byte) CClientSocket {
	if gSetting == nil {
		panic("[CClientSocket] Please use msnet.New(setting) to install package")
	}
	cs := &clientSocket{
		delegate:      delegate,
		CPMap:         make(map[uint16]uint16),
		aliveStopChan: make(chan struct{}),
	}
	if conn != nil {
		cs.sock = conn
		cs.addr = conn.RemoteAddr()
	}
	// Cipher Type
	cs.recvCipherType = gSetting.RecvCipherType
	cs.sendCipherType = gSetting.SendCipherType
	// IV
	if len(recvIV) == 0 {
		cs.recvIV = make([]byte, IVSize)
		crand.Read(cs.recvIV)
	} else {
		cs.recvIV = recvIV
	}
	if len(sendIV) == 0 {
		cs.sendIV = make([]byte, IVSize)
		crand.Read(cs.sendIV)
	} else {
		cs.sendIV = sendIV
	}
	return cs
}

// Connect implements [CClientSocket].
func (cs *clientSocket) Connect(addr string) error {
	// Dial
	tcpAddr, err := net.ResolveTCPAddr("tcp", addr)
	if err != nil {
		return err
	}
	conn, err := net.DialTCP("tcp", nil, tcpAddr)
	if err != nil {
		return err
	}
	cs.sock = conn
	cs.addr = conn.RemoteAddr()
	// Read connect packet
	buf := make([]byte, 16)
	_, err = io.ReadFull(cs.sock, buf)
	if err != nil {
		return err
	}
	iPacket := NewCInPacket(buf)
	_ = iPacket.Decode2() // PacketLen
	version := uint16(iPacket.Decode2())
	if version != gSetting.MSVersion {
		return fmt.Errorf("invalid client version %d", version)
	}
	minorVersion := iPacket.DecodeStr()
	if minorVersion != gSetting.MSMinorVersion {
		return fmt.Errorf("invalid client minorVersion %s", minorVersion)
	}
	cs.sendIV = iPacket.DecodeBuffer(4)
	cs.recvIV = iPacket.DecodeBuffer(4)
	region := Region(iPacket.Decode1())
	if region != gSetting.MSRegion {
		return fmt.Errorf("invalid client region %d", region)
	}
	go cs.OnRead()
	return nil
}

// SendAliveAck implements [CClientSocket].
func (cs *clientSocket) SendAliveAck(cpAliveAck uint16) {
	oPacket := NewCOutPacket(cpAliveAck)
	cs.SendPacket(oPacket)
}

// SendChecksum implements [CClientSocket].
func (cs *clientSocket) SendChecksum(cpChecksum uint16, dataLen int16) {
	oPacket := NewCOutPacket(cpChecksum)
	oPacket.Encode2(dataLen)
	cs.SendPacket(oPacket)
}

// OnCheckSum implements [CClientSocket].
func (cs *clientSocket) OnCheckSum(lpCheckSum uint16, data []byte) {
	oPacket := NewCOutPacket(lpCheckSum)
	oPacket.Encode4(int32(crypt.CalcuChecksum(data)))
	oPacket.Encode2(int16(len(data)))
	oPacket.EncodeBuffer(data)
	cs.SendPacket(oPacket)
}

// SetID implements [CClientSocket].
func (cs *clientSocket) SetID(id int32) {
	cs.id = id
}

// GetID implements [CClientSocket].
func (cs *clientSocket) GetID() int32 {
	return cs.id
}

// GetAddr implements [CClientSocket].
func (cs *clientSocket) GetAddr() string {
	return cs.addr.String()
}

// OnRead implements [CClientSocket].
func (cs *clientSocket) OnRead() {
	defer cs.Close()
	for {
		// Decrypt packet header
		headerBuf := make([]byte, HeaderLength)
		_, err := io.ReadFull(cs.sock, headerBuf)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				slog.Debug("[OnRead] HeaderBuf", "err", err)
			} else {
				slog.Error("[OnRead] HeaderBuf", "err", err)
			}
			return
		}
		iPacket := NewCInPacket(headerBuf)
		rawSeq, dataLen := iPacket.DecryptHeader(cs.recvCipherType)
		clientVersion := rawSeq ^ binary.LittleEndian.Uint16(cs.recvIV[2:4])
		if clientVersion != gSetting.MSVersionAuth && ^clientVersion != gSetting.MSVersionAuth {
			cs.OnError(errors.New("failed to decrypt packet header"))
			return
		}
		// Decrypt packet data
		dataBuf := make([]byte, dataLen)
		_, err = io.ReadFull(cs.sock, dataBuf)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				slog.Debug("[OnRead] DataBuf", "err", err)
			} else {
				slog.Error("[OnRead] DataBuf", "err", err)
			}
			return
		}
		iPacket.DecryptData(cs.recvCipherType, dataBuf, cs.recvIV)
		cs.InnoHash(cs.recvCipherType, cs.recvIV)
		cs.delegate.DebugInPacketLog(cs.id, iPacket)
		cs.delegate.ProcessPacket(cs, iPacket)
	}
}

// OnConnect implements [CClientSocket].
func (cs *clientSocket) OnConnect() {
	oPacket := cs.delegate.NewConnectPacket(
		gSetting.MSRegion,
		gSetting.MSVersion,
		gSetting.MSMinorVersion,
		cs.recvIV,
		cs.sendIV,
	)
	if oPacket == nil {
		oPacket = NewCOutPacket()
		oPacket.EncodeStr(gSetting.MSMinorVersion)
		oPacket.EncodeBuffer(cs.recvIV)
		oPacket.EncodeBuffer(cs.sendIV)
		oPacket.Encode1(int8(gSetting.MSRegion))
	}
	sendBuf := oPacket.MakeBufferList(NullCipher, nil)
	cs.Flush(sendBuf)
	slog.Debug("[OnConnect]",
		"id", cs.id,
		"headerLen", HeaderLength,
		"header", fmt.Sprintf("% 02X", sendBuf[:HeaderLength]),
		"dataLen", oPacket.GetLength(),
		"data", oPacket.DumpString(-1),
	)
}

// InnoHash implements [CClientSocket].
func (cs *clientSocket) InnoHash(cipherType CipherType, dwKey []byte) {
	switch cipherType {
	case AESCipher, LinearCipher:
		(*crypt.CIGCipher).InnoHash(nil, dwKey)
	case XORCipher:
		(*crypt.XORCipher).Shuffle(nil, dwKey)
	case IGCipher:
		(*crypt.CIGCipher).InnoHashOld(nil, dwKey)
	case NullCipher:
		// Nothing
	default:
		slog.Warn("Unknown cipher type when Stepping", "cipherType", cipherType)
	}
}

// LoopAliveAck implements [CClientSocket].
func (cs *clientSocket) LoopAliveAck(aliveAckSec int) {
	if aliveAckSec <= 0 {
		return
	}
	aliveTimeout := time.Duration(aliveAckSec) * time.Second
	cs.lastAliveAckTime = time.Now()
	ticker := time.NewTicker(aliveTimeout / 2)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if time.Since(cs.lastAliveAckTime) > aliveTimeout {
				cs.OnError(errors.New("failed to check client socket alive"))
				return
			}
		case <-cs.aliveStopChan:
			return
		}
	}
}

// OnAliveAck implements [CClientSocket].
func (cs *clientSocket) OnAliveAck() {
	cs.lastAliveAckTime = time.Now()
}

// LoopAliveReq implements [CClientSocket].
func (cs *clientSocket) LoopAliveReq(aliveReqSec int, lpAliveReq uint16) {
	if aliveReqSec <= 0 {
		return
	}
	aliveReqTime := time.Duration(aliveReqSec) * time.Second
	ticker := time.NewTicker(aliveReqTime)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			cs.OnAliveReq(lpAliveReq)
		case <-cs.aliveStopChan:
			return
		}
	}
}

// OnAliveReq implements [CClientSocket].
func (cs *clientSocket) OnAliveReq(lpAliveReq uint16) {
	oPacket := NewCOutPacket(lpAliveReq)
	cs.SendPacket(oPacket)
}

// SetRecvCipherType implements [CClientSocket].
func (cs *clientSocket) SetRecvCipherType(cipherType CipherType) {
	cs.recvCipherType = cipherType
}

// SetSendCipherType implements [CClientSocket].
func (cs *clientSocket) SetSendCipherType(cipherType CipherType) {
	cs.sendCipherType = cipherType
}

// OnOpcodeEncryption implements [CClientSocket].
func (cs *clientSocket) OnOpcodeEncryption(lpOpcodeEncryption uint16, startOpcode uint16, endOpcode uint16, isSplit bool) {
	var builder strings.Builder
	if isSplit {
		// Write opcodes range
		fmt.Fprintf(&builder, "%04d", endOpcode-startOpcode+1)
		builder.WriteRune('|')
	}
	// Convert opcode to rand num
	maxOp := int32(math.MaxUint16)
	for op := startOpcode; op <= endOpcode; op++ {
		// Bind rand num with opcode
		minOp := int32(op)
		var randNum uint16
		for {
			//nolint:gosec // math/rand is fine for non-cryptographic random numbers
			randNum = uint16(mrand.Int32N(maxOp-minOp+1) + minOp)
			if _, ok := cs.CPMap[randNum]; !ok {
				break
			}
		}
		cs.CPMap[randNum] = op
		// Write rand num to replace opcode
		fmt.Fprintf(&builder, "%04d", randNum)
		if isSplit && op < endOpcode {
			// Add separator symbol
			builder.WriteRune('|')
		}
	}
	// Using TripleDESCipher encrypt content
	content := builder.String()
	encryptedBuf, err := (*crypt.TripleDESCipher).Encrypt(nil, content)
	if err != nil {
		slog.Error("[CClientSocket] Failed to encrypt content using TripleDESCipher", "id", cs.id, "err", err)
		return
	}
	oPacket := NewCOutPacket(lpOpcodeEncryption)
	if !isSplit {
		oPacket.Encode4(int32(crypt.GetDESCipherBlockSize()))
	}
	oPacket.Encode4(int32(len(encryptedBuf)))
	oPacket.EncodeBuffer(encryptedBuf)
	cs.SendPacket(oPacket)
}

// DecryptOpcode implements [CClientSocket].
func (cs *clientSocket) DecryptOpcode(randNum uint16) uint16 {
	op, ok := cs.CPMap[randNum]
	if !ok {
		return 0
	}
	return op
}

// SendPacket implements [CClientSocket].
func (cs *clientSocket) SendPacket(oPacket COutPacket) {
	cs.sendMu.Lock()
	defer cs.sendMu.Unlock()
	cs.delegate.DebugOutPacketLog(cs.id, oPacket)
	sendBuf := oPacket.MakeBufferList(cs.sendCipherType, cs.sendIV)
	cs.InnoHash(cs.sendCipherType, cs.sendIV)
	cs.Flush(sendBuf)
}

// Flush implements [CClientSocket].
func (cs *clientSocket) Flush(buf []byte) {
	if cs.sock == nil {
		return
	}
	bufLen := len(buf)
	writtenLen := 0
	for writtenLen < bufLen {
		n, err := cs.sock.Write(buf[writtenLen:])
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				slog.Debug("[Flush] Client disconnected", "id", cs.id, "err", err)
			} else {
				slog.Error("[Flush] Failed to send packet to client", "id", cs.id, "err", err)
			}
			return
		}
		writtenLen += n
	}
}

// OnError implements [CClientSocket].
func (cs *clientSocket) OnError(err error) {
	slog.Error("[CClientSocket] OnError", "id", cs.id, "err", err)
	cs.Close()
}

// Close implements [CClientSocket].
func (cs *clientSocket) Close() {
	err := cs.sock.Close()
	if err != nil {
		if errors.Is(err, net.ErrClosed) {
			slog.Debug("[CClientSocket] Close", "id", cs.id, "err", err)
		} else {
			slog.Error("[CClientSocket] Close", "id", cs.id, "err", err)
		}
		return
	}
	close(cs.aliveStopChan)
	cs.delegate.SocketClose(cs.id)
}
