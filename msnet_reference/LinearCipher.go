package crypt

type LinearCipher struct{}

func (static *LinearCipher) Decrypt(buf []byte, dwKey []byte) {
	inputKey := dwKey[0]
	for i := range buf {
		buf[i] -= inputKey
	}
}

func (static *LinearCipher) Encrypt(buf []byte, dwKey []byte) {
	inputKey := dwKey[0]
	for i := range buf {
		buf[i] += inputKey
	}
}
