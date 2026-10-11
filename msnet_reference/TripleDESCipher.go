package crypt

import (
	"bytes"
	"crypto/cipher"
	"crypto/des" //nolint:gosec // required for legacy DES compatibility
	"errors"
	"sync"
)

//nolint:gochecknoglobals // Zero Redundant Overhead
var (
	gDESCipherOnce  sync.Once
	gDESCipherBlock cipher.Block
)

type TripleDESCipher struct{}

func InitTripleDESCipher(desKey string) {
	gDESCipherOnce.Do(func() {
		finalKey := make([]byte, 24)
		switch len(desKey) {
		case 16:
			copy(finalKey[0:16], desKey)
			copy(finalKey[16:24], desKey[0:8])
		case 24:
			copy(finalKey, desKey)
		default:
			panic("des key length must be 16 or 24 byte")
		}
		temp, err := des.NewTripleDESCipher(finalKey) //nolint:gosec // required for legacy DES compatibility
		if err != nil {
			panic(err)
		}
		gDESCipherBlock = temp
	})
}

func GetDESCipherBlockSize() int {
	return gDESCipherBlock.BlockSize()
}

func (static *TripleDESCipher) Encrypt(content string) ([]byte, error) {
	if gDESCipherBlock == nil {
		return nil, errors.New("cipher block is empty")
	}
	buf := []byte(content)
	blockSize := gDESCipherBlock.BlockSize()
	if len(buf)%blockSize != 0 {
		paddingLen := blockSize - (len(buf) % blockSize)
		paddingText := bytes.Repeat([]byte{' '}, paddingLen)
		buf = append(buf, paddingText...)
	}
	for i := 0; i < len(buf); i += blockSize {
		gDESCipherBlock.Encrypt(buf[i:i+blockSize], buf[i:i+blockSize])
	}
	return buf, nil
}

func (static *TripleDESCipher) Decrypt(buf []byte) (string, error) {
	if gDESCipherBlock == nil {
		return "", errors.New("cipher block is empty")
	}
	blockSize := gDESCipherBlock.BlockSize()
	if len(buf)%blockSize != 0 {
		paddingLen := blockSize - (len(buf) % blockSize)
		paddingText := bytes.Repeat([]byte{' '}, paddingLen)
		buf = append(buf, paddingText...)
	}

	for i := 0; i < len(buf); i += blockSize {
		gDESCipherBlock.Decrypt(buf[i:i+blockSize], buf[i:i+blockSize])
	}
	content := string(bytes.TrimRight(buf, " "))
	return content, nil
}
