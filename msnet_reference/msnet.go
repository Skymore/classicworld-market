package msnet

import (
	"time"

	"github.com/zhyonc/msnet/internal/crypt"
)

//nolint:gochecknoglobals // globals used to reduce parameter passing across functions
var (
	gSetting *Setting
)

func New(setting *Setting) {
	if setting == nil {
		panic("Unknown setting")
	}
	gSetting = setting
	// Locale
	SetLocale(gSetting.LocaleRegion)
	// VersionAuth
	if gSetting.MSVersionAuth == 0 {
		gSetting.MSVersionAuth = gSetting.MSVersion
	}
	// DESKey
	if gSetting.DESKey != "" {
		crypt.InitTripleDESCipher(gSetting.DESKey)
	}
	// AESKey
	aesKey := setting.AESKey
	if aesKey[0] == 0 {
		switch gSetting.AESKeyType {
		case DefaultKey:
			aesKey = AESKeyDefault
		case CycleKey:
			aesKey = CycleAESKeys[gSetting.MSVersion%20]
		case CycleKey13:
			aesKey = CycleAESKeys[(gSetting.MSVersion+13)%20]
		default:
			panic("Unknown aes key type")
		}
	}
	crypt.InitCAESCipher(aesKey, uint8(gSetting.AESInitType))
}

type CClientSocket interface {
	CClientSocketTest
	SetID(id int32)
	GetID() int32
	GetAddr() string
	OnRead()
	OnConnect()
	InnoHash(cipherType CipherType, dwKey []byte)
	LoopAliveAck(aliveAckSec int)
	OnAliveAck()
	LoopAliveReq(aliveReqSec int, lpAliveReq uint16)
	OnAliveReq(lpAliveReq uint16)
	SetRecvCipherType(cipherType CipherType)
	SetSendCipherType(cipherType CipherType)
	OnOpcodeEncryption(lpOpcodeEncryption uint16, startOpcode uint16, endOpcode uint16, isSplit bool)
	DecryptOpcode(randNum uint16) uint16
	SendPacket(oPacket COutPacket)
	Flush(buf []byte)
	OnError(err error)
	Close()
}

type CClientSocketTest interface {
	Connect(addr string) error
	SendAliveAck(cpAliveAck uint16)
	SendChecksum(cpChecksum uint16, dataLen int16)
	OnCheckSum(lpCheckSum uint16, data []byte)
}

type CClientSocketDelegate interface {
	DebugInPacketLog(id int32, iPacket CInPacket)
	DebugOutPacketLog(id int32, oPacket COutPacket)
	NewConnectPacket(region Region, version uint16, minorVersion string, recvIV []byte, sendIV []byte) COutPacket
	ProcessPacket(cs CClientSocket, iPacket CInPacket)
	SocketClose(id int32)
}

type CInPacket interface {
	DecryptHeader(cipherType CipherType) (uint16, uint16)
	DecryptData(cipherType CipherType, pBuff []byte, dwKey []byte)
	GetType() uint16
	GetRemain() int
	GetOffset() int
	GetLength() int
	DecodeBool() bool
	Decode1() int8
	Decode2() int16
	Decode4() int32
	Decode8() int64
	DecodeBuffer(uSize int) []byte
	DecodeStr() string
	DecodeName(uSize ...int) string
	DecodeTime() uint32
	DecodeDateTime() time.Time
	DumpString(nSize int) string
	Clear()
}

type COutPacket interface {
	GetType() uint16
	GetSendBuffer() []byte
	GetOffset() int
	GetLength() int
	EncodeBool(b bool)
	Encode1(n int8)
	Encode2(n int16)
	Encode4(n int32)
	Encode8(n int64)
	EncodeBuffer(buf []byte)
	EncodeStr(s string)
	EncodeName(s string, uSize ...int)
	EncodeTime(tTime uint32)
	EncodeDateTime(dTime time.Time)
	EncryptHeader(cipherType CipherType, pBuff []byte, dataLen int, dwKey []byte)
	MakeBufferList(cipherType CipherType, dwKey []byte) []byte
	DumpString(nSize int) string
}
