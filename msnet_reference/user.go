package msnet

import (
	"fmt"
	"log/slog"

	"github.com/zhyonc/msnet/internal/crypt"
	"github.com/zhyonc/msnet/internal/opcode"
)

type User struct {
	CS       CClientSocket
	IsValid  bool
	DoneChan chan struct{}
}

func NewUser(id int32) *User {
	u := new(User)
	u.CS = NewCClientSocket(u, nil, nil, nil)
	u.CS.SetID(id)
	u.DoneChan = make(chan struct{})
	return u
}

// DebugInPacketLog implements [CClientSocketDelegate].
func (u *User) DebugInPacketLog(id int32, iPacket CInPacket) {
	key := iPacket.GetType()
	_, ok := opcode.NotLogCP[key]
	if !ok {
		tag := opcode.CPMap[key]
		slog.Debug("[CInPacket]",
			"id", id,
			"opcode", fmt.Sprintf("%d/0x%04X", key, key),
			"tag", tag,
			"dataLen", iPacket.GetLength(),
			"data", iPacket.DumpString(-1),
		)
	}
}

// DebugOutPacketLog implements [CClientSocketDelegate].
func (u *User) DebugOutPacketLog(id int32, oPacket COutPacket) {
	key := oPacket.GetType()
	_, ok := opcode.NotLogLP[key]
	if !ok {
		tag := opcode.LPMap[key]
		slog.Debug("[COutPacket]",
			"id", id,
			"opcode", fmt.Sprintf("%d/0x%04X", key, key),
			"tag", tag,
			"dataLen", oPacket.GetLength(),
			"data", oPacket.DumpString(-1),
		)
	}
}

// NewConnectPacket implements [CClientSocketDelegate].
func (u *User) NewConnectPacket(_ Region, _ uint16, _ string, _ []byte, _ []byte) COutPacket {
	return nil
}

// ProcessPacket implements [CClientSocketDelegate].
func (u *User) ProcessPacket(cs CClientSocket, iPacket CInPacket) {
	op := iPacket.Decode2()
	switch op {
	case opcode.LP_Checksum:
		defer close(u.DoneChan)
		dataChecksum := uint32(iPacket.Decode4())
		dataLen := iPacket.Decode2()
		data := iPacket.DecodeBuffer(int(dataLen))
		actualDataChecksum := crypt.CalcuChecksum(data)
		if dataChecksum != actualDataChecksum {
			cs.OnError(fmt.Errorf("checksum mismatch: expected: %d got: %d", actualDataChecksum, dataChecksum))
			return
		}
		u.IsValid = true
	case opcode.LP_AliveReq:
		cs.SendAliveAck(opcode.CP_AliveAck)
	default:
		slog.Warn("Unprocessed CInPacket", "opcode", fmt.Sprintf("%d/0x%04X", op, op))
	}
}

// SocketClose implements [CClientSocketDelegate].
func (u *User) SocketClose(id int32) {
	slog.Debug("Socket closed", "id", id)
}
