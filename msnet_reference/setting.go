package msnet

type Setting struct {
	LocaleRegion      Region
	MSRegion          Region
	MSVersion         uint16
	MSVersionAuth     uint16
	MSMinorVersion    string
	RecvCipherType    CipherType
	SendCipherType    CipherType
	DESKey            string
	AESKeyType        AESKeyType
	AESKey            [32]byte
	IsTypeHeader1Byte bool
	AESInitType       AESInitType
}
