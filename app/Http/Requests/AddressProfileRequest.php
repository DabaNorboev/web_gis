<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class AddressProfileRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['radius_m' => ['sometimes', 'integer', 'in:300,500']];
    }
}
