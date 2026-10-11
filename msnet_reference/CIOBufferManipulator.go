package crypt

// Shanda encryption is used for CMS/MSEA/GMS/EMS/BMS

type CIOBufferManipulator struct{}

//nolint:ineffassign,wastedassign // reset state for next loop
func (static *CIOBufferManipulator) De(buf []byte) {
	var j int32
	var a, b, c byte

	for range byte(3) {
		a = 0
		b = 0

		for j = int32(len(buf)); j > 0; j-- {
			c = buf[j-1]
			c = ROL1(c, 3)
			c ^= 0x13
			a = c
			c ^= b
			c = byte(int32(c) - j)
			c = ROR1(c, 4)
			b = a
			buf[j-1] = c
		}

		a = 0
		b = 0

		for j = int32(len(buf)); j > 0; j-- {
			c = buf[int32(len(buf))-j]
			c -= 0x48
			c ^= 0xFF
			c = ROL1(c, int(j))
			a = c
			c ^= b
			c = byte(int32(c) - j)
			c = ROR1(c, 3)
			b = a
			buf[int32(len(buf))-j] = c
		}
	}
}

func (static *CIOBufferManipulator) En(buf []byte) {
	var j int32
	var a, c byte
	for range byte(3) {
		a = 0

		for j = int32(len(buf)); j > 0; j-- {
			c = buf[int32(len(buf))-j]
			c = ROL1(c, 3)
			c = byte(int32(c) + j)
			c ^= a
			a = c
			c = ROR1(a, int(j))
			c ^= 0xFF
			c += 0x48
			buf[int32(len(buf))-j] = c
		}

		a = 0

		for j = int32(len(buf)); j > 0; j-- {
			c = buf[j-1]
			c = ROL1(c, 4)
			c = byte(int32(c) + j)
			c ^= a
			a = c
			c ^= 0x13
			c = ROR1(c, 3)
			buf[j-1] = c
		}
	}
}
