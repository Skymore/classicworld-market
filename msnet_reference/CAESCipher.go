package crypt

import (
	"crypto/aes"
	"crypto/cipher"
	"log/slog"
	"sync"
)

//nolint:gochecknoglobals // Zero Redundant Overhead
var (
	defaultKey = []byte{
		0xF2, 0x53, 0x50, 0xC6, // -229420858
		0x7F, 0x9D, 0x42, 0xA8, // 2141012648
		0x26, 0x1D, 0x09, 0x77, // 639437175
		0x7C, 0x88, 0x53, 0x42, // 2089308994
	}
	gAESCipherOnce  sync.Once
	gAESCipherBlock cipher.Block
	gAESInitType    uint8
)

type CAESCipher struct{}

func InitCAESCipher(aesKey [32]byte, aesInitType uint8) {
	gAESCipherOnce.Do(func() {
		block, err := aes.NewCipher(aesKey[:])
		if err != nil {
			panic(err)
		}
		gAESCipherBlock = block
		gAESInitType = aesInitType
	})
}

// Decrypt is void __cdecl CAESCipher::Decrypt(unsigned __int8 *pDest, unsigned __int8 *pSrc, int nLen, unsigned int *pdwKey).
func (static *CAESCipher) Decrypt(buf []byte, dwkey []byte) {
	chainVar := static.AESInit(dwkey)
	if len(buf) > 0 {
		// The cipher.NewOFB stream handles the decryption in a single step using XORKeyStream
		static.OFBUpdate(buf, chainVar)
	}
	// No separate completion steps required.
	// OFB_DecFinal(AlgInfo, pDest)
}

// Encrypt is void __cdecl CAESCipher::Encrypt(unsigned __int8 *pDest, unsigned __int8 *pSrc, int nLen, unsigned int *pdwKey).
func (static *CAESCipher) Encrypt(buf []byte, dwkey []byte) {
	chainVar := static.AESInit(dwkey)
	if len(buf) > 0 {
		// The cipher.NewOFB stream handles the encryption in a single step using XORKeyStream
		static.OFBUpdate(buf, chainVar)
	}
	// No separate completion steps required.
	// OFB_EncFinal(AlgInfo, pDest)
}

// AESInit is void __cdecl CAESCipher::AES_DecInit(CAESCipher::AES_ALG_INFO *AlgInfo, unsigned int *pdwKey).
// AESInit is void __cdecl CAESCipher::AES_EncInit(CAESCipher::AES_ALG_INFO *AlgInfo, unsigned int *pdwKey).
func (static *CAESCipher) AESInit(dwKey []byte) []byte {
	chainVar := make([]byte, gAESCipherBlock.BlockSize())
	if len(dwKey) > 0 {
		switch gAESInitType {
		case 0:
			// Default: Used in versions after about 2008
			for i := range 4 {
				copy(chainVar[4*i:], dwKey)
			}
		case 1:
			// Duplicate: Used in versions about 2005~2007 (excluding TMS)
			for i := range chainVar {
				chainVar[i] = dwKey[0]
			}
		case 2:
			// Shuffle: Used in TMS versions about 2005~2007
			tempKey := make([]byte, 4)
			copy(tempKey, dwKey)
			for i := range 4 {
				(*CIGCipher).Shuffle(nil, tempKey, bShuffle[i])
				copy(chainVar[4*i:], tempKey)
			}
		default:
			slog.Warn("Invaild aes init type", "aesInitType", gAESInitType)
			copy(chainVar, defaultKey)
		}
	} else {
		// The default key is rarely used so i didn't test it
		copy(chainVar, defaultKey)
	}
	return chainVar
}

// OFBUpdate is char __cdecl CAESCipher::OFB_DecUpdate(CAESCipher::AES_ALG_INFO *AlgInfo,char *CipherTxt,unsigned int CipherTxtLen,char *PlainTxt,unsigned int *PlainTxtLen).
// OFBUpdate is char __cdecl CAESCipher::OFB_EncUpdate(CAESCipher::AES_ALG_INFO *AlgInfo,char *PlainTxt,unsigned int PlainTxtLen,char *CipherTxt,unsigned int *CipherTxtLen).
func (static *CAESCipher) OFBUpdate(buf []byte, chainVar []byte) {
	stream := cipher.NewOFB(gAESCipherBlock, chainVar) //nolint:staticcheck // required for legacy OFB compatibility
	stream.XORKeyStream(buf, buf)
}
